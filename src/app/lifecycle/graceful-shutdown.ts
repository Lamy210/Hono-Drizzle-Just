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

function defaultSleep(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, delayMs));
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
    this.server = options.server;
    this.lifecycle = options.lifecycle;
    this.logger = options.logger;
    this.timeoutMs = Math.max(0, options.timeoutMs);
    this.drainDelayMs = Math.max(0, options.drainDelayMs ?? 0);
    this.beginDrain = options.beginDrain ?? (() => undefined);
    this.sleep = options.sleep ?? defaultSleep;
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
