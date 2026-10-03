import type { LogContext, Logger } from "../../core/logging/logger";

export interface StoppableServer {
  stop(closeActiveConnections?: boolean): Promise<void>;
}

export interface ClosableLifecycle {
  close(): Promise<void>;
}

export interface GracefulShutdownOptions {
  readonly server: StoppableServer;
  readonly lifecycle: ClosableLifecycle;
  readonly logger: Logger;
  readonly timeoutMs: number;
  readonly drainDelayMs?: number;
  readonly beginDrain?: () => void;
  readonly sleep?: (delayMs: number) => Promise<void>;
}

function nonNegativeFiniteNumber(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite number greater than or equal to 0`);
  }
  return value;
}

function defaultSleep(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function snapshotGracefulShutdownOptions(options: unknown): GracefulShutdownOptions {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("GracefulShutdownCoordinator options must be a non-array object");
  }

  let isArray: boolean;
  try {
    isArray = Array.isArray(options);
  } catch {
    throw new TypeError("GracefulShutdownCoordinator options could not be read");
  }
  if (isArray) {
    throw new TypeError("GracefulShutdownCoordinator options must be a non-array object");
  }

  try {
    const server = Reflect.get(options, "server") as GracefulShutdownOptions["server"];
    const lifecycle = Reflect.get(options, "lifecycle") as GracefulShutdownOptions["lifecycle"];
    const logger = Reflect.get(options, "logger") as GracefulShutdownOptions["logger"];
    const timeoutMs = Reflect.get(options, "timeoutMs") as GracefulShutdownOptions["timeoutMs"];
    const drainDelayMs = Reflect.get(
      options,
      "drainDelayMs",
    ) as GracefulShutdownOptions["drainDelayMs"];
    const beginDrain = Reflect.get(
      options,
      "beginDrain",
    ) as GracefulShutdownOptions["beginDrain"];
    const sleep = Reflect.get(options, "sleep") as GracefulShutdownOptions["sleep"];

    return {
      server,
      lifecycle,
      logger,
      timeoutMs,
      ...(drainDelayMs === undefined ? {} : { drainDelayMs }),
      ...(beginDrain === undefined ? {} : { beginDrain }),
      ...(sleep === undefined ? {} : { sleep }),
    };
  } catch {
    throw new TypeError("GracefulShutdownCoordinator options could not be read");
  }
}

function requireBeginDrain(value: unknown): () => void {
  if (typeof value !== "function") {
    throw new TypeError("GracefulShutdownCoordinator beginDrain must be callable");
  }
  return value as () => void;
}

function requireSleep(value: unknown): (delayMs: number) => Promise<void> {
  if (typeof value !== "function") {
    throw new TypeError("GracefulShutdownCoordinator sleep must be callable");
  }
  return value as (delayMs: number) => Promise<void>;
}

export class GracefulShutdownCoordinator {
  private readonly server: StoppableServer;
  private readonly lifecycle: ClosableLifecycle;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly drainDelayMs: number;
  private readonly beginDrain: () => void;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private shutdownPromise: Promise<void> | undefined;

  constructor(options: GracefulShutdownOptions) {
    const normalizedOptions = snapshotGracefulShutdownOptions(options);
    this.server = normalizedOptions.server;
    this.lifecycle = normalizedOptions.lifecycle;
    this.logger = normalizedOptions.logger;
    this.timeoutMs = nonNegativeFiniteNumber("timeoutMs", normalizedOptions.timeoutMs);
    this.drainDelayMs =
      normalizedOptions.drainDelayMs === undefined
        ? 0
        : nonNegativeFiniteNumber("drainDelayMs", normalizedOptions.drainDelayMs);
    this.beginDrain =
      normalizedOptions.beginDrain === undefined
        ? () => undefined
        : requireBeginDrain(normalizedOptions.beginDrain);
    this.sleep =
      normalizedOptions.sleep === undefined ? defaultSleep : requireSleep(normalizedOptions.sleep);
  }

  shutdown(signal: string): Promise<void> {
    this.shutdownPromise ??= this.performShutdown(signal);
    return this.shutdownPromise;
  }

  private async performShutdown(signal: string): Promise<void> {
    this.infoBestEffort("server.stopping", {
      signal,
      timeoutMs: this.timeoutMs,
      drainDelayMs: this.drainDelayMs,
    });
    const errors: unknown[] = [];

    try {
      this.beginDrain();
      if (this.drainDelayMs > 0) {
        this.infoBestEffort("server.draining", {
          signal,
          drainDelayMs: this.drainDelayMs,
        });
        await this.sleep(this.drainDelayMs);
      }
    } catch (error) {
      errors.push(error);
    }

    try {
      const stoppedGracefully = await this.settlesWithin(this.server.stop(false), this.timeoutMs);
      if (!stoppedGracefully) {
        this.warnBestEffort("server.shutdown.deadline_exceeded", {
          signal,
          timeoutMs: this.timeoutMs,
        });
        await this.server.stop(true);
      }
    } catch (error) {
      errors.push(error);
      try {
        await this.server.stop(true);
      } catch (forceStopError) {
        errors.push(forceStopError);
      }
    }

    try {
      await this.lifecycle.close();
    } catch (error) {
      errors.push(error);
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, "Application shutdown completed with errors");
    }

    this.infoBestEffort("server.stopped", { signal });
  }

  private infoBestEffort(message: string, context: LogContext): void {
    try {
      this.logger.info(message, context);
    } catch {
      // Shutdown control flow is authoritative; observability must remain best-effort.
    }
  }

  private warnBestEffort(message: string, context: LogContext): void {
    try {
      this.logger.warn(message, context);
    } catch {
      // Shutdown control flow is authoritative; observability must remain best-effort.
    }
  }

  private async settlesWithin(operation: Promise<void>, timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}
