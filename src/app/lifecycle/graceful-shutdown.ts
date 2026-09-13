import type { Logger } from "../../core/logging/logger";

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
}

export class GracefulShutdownCoordinator {
  private readonly server: StoppableServer;
  private readonly lifecycle: ClosableLifecycle;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private shutdownPromise: Promise<void> | undefined;

  constructor(options: GracefulShutdownOptions) {
    this.server = options.server;
    this.lifecycle = options.lifecycle;
    this.logger = options.logger;
    this.timeoutMs = Math.max(0, options.timeoutMs);
  }

  shutdown(signal: string): Promise<void> {
    this.shutdownPromise ??= this.performShutdown(signal);
    return this.shutdownPromise;
  }

  private async performShutdown(signal: string): Promise<void> {
    this.logger.info("server.stopping", { signal, timeoutMs: this.timeoutMs });
    const errors: unknown[] = [];

    try {
      const stoppedGracefully = await this.settlesWithin(this.server.stop(false), this.timeoutMs);
      if (!stoppedGracefully) {
        this.logger.warn("server.shutdown.deadline_exceeded", {
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

    this.logger.info("server.stopped", { signal });
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
