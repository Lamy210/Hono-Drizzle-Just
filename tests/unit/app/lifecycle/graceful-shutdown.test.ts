import { describe, expect, mock, test } from "bun:test";
import {
  GracefulShutdownCoordinator,
  type GracefulShutdownOptions,
} from "../../../../src/app/lifecycle/graceful-shutdown";
import { JsonConsoleLogger } from "../../../../src/infrastructure/logging/json-console-logger";

function logger() {
  return new JsonConsoleLogger({ service: "test" }, () => undefined);
}

describe("GracefulShutdownCoordinator", () => {
  test("marks readiness down and waits for drain propagation before stopping the server", async () => {
    const calls: string[] = [];
    const server = {
      stop: mock(async (force?: boolean) => void calls.push(`stop:${String(force)}`)),
    };
    const lifecycle = {
      close: mock(async () => void calls.push("close")),
    };
    const coordinator = new GracefulShutdownCoordinator({
      server,
      lifecycle,
      logger: logger(),
      timeoutMs: 1_000,
      drainDelayMs: 250,
      beginDrain: () => void calls.push("drain"),
      sleep: async (delayMs) => void calls.push(`sleep:${delayMs}`),
    });

    await coordinator.shutdown("SIGTERM");

    expect(calls).toEqual(["drain", "sleep:250", "stop:false", "close"]);
  });

  test("zero drain delay preserves immediate graceful stop after marking not ready", async () => {
    const calls: string[] = [];
    const server = {
      stop: mock(async (force?: boolean) => void calls.push(`stop:${String(force)}`)),
    };
    const lifecycle = {
      close: mock(async () => void calls.push("close")),
    };
    const coordinator = new GracefulShutdownCoordinator({
      server,
      lifecycle,
      logger: logger(),
      timeoutMs: 1_000,
      beginDrain: () => void calls.push("drain"),
    });

    await coordinator.shutdown("SIGTERM");

    expect(calls).toEqual(["drain", "stop:false", "close"]);
  });

  test("rejects invalid runtime shutdown timing values", () => {
    const server = { stop: mock(async () => undefined) };
    const lifecycle = { close: mock(async () => undefined) };
    const invalidTimeouts = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      null,
      undefined,
      "1000",
    ];

    for (const timeoutMs of invalidTimeouts) {
      expect(
        () =>
          new GracefulShutdownCoordinator({
            server,
            lifecycle,
            logger: logger(),
            timeoutMs: timeoutMs as unknown as number,
          }),
      ).toThrow("timeoutMs must be a finite number greater than or equal to 0");
    }

    const invalidDrainDelays = [Number.NaN, Number.POSITIVE_INFINITY, -1, null, "250"];
    for (const drainDelayMs of invalidDrainDelays) {
      expect(
        () =>
          new GracefulShutdownCoordinator({
            server,
            lifecycle,
            logger: logger(),
            timeoutMs: 1_000,
            drainDelayMs: drainDelayMs as unknown as number,
          }),
      ).toThrow("drainDelayMs must be a finite number greater than or equal to 0");
    }
  });

  test("rejects invalid runtime option containers", () => {
    for (const options of [null, "options", 1, true, [], () => undefined]) {
      expect(
        () => new GracefulShutdownCoordinator(options as unknown as GracefulShutdownOptions),
      ).toThrow("GracefulShutdownCoordinator options must be a non-array object");
    }
  });

  test("normalizes throwing option getters before construction continues", () => {
    const secret = "private-shutdown-option-detail";
    const options = {
      server: { stop: mock(async () => undefined) },
      lifecycle: { close: mock(async () => undefined) },
      logger: logger(),
      timeoutMs: 1_000,
      get sleep(): (delayMs: number) => Promise<void> {
        throw new Error(secret);
      },
    } as GracefulShutdownOptions;

    let caught: unknown;
    try {
      new GracefulShutdownCoordinator(options);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect(caught).toMatchObject({
      message: "GracefulShutdownCoordinator options could not be read",
      cause: undefined,
    });
    expect(String(caught)).not.toContain(secret);
  });

  test("snapshots constructor options exactly once", async () => {
    const reads = {
      server: 0,
      lifecycle: 0,
      logger: 0,
      timeoutMs: 0,
      drainDelayMs: 0,
      beginDrain: 0,
      sleep: 0,
    };
    const calls: string[] = [];
    const server = {
      stop: mock(async (force?: boolean) => void calls.push(`stop:${String(force)}`)),
    };
    const lifecycle = {
      close: mock(async () => void calls.push("close")),
    };
    const runtimeOptions = {
      get server() {
        reads.server += 1;
        return server;
      },
      get lifecycle() {
        reads.lifecycle += 1;
        return lifecycle;
      },
      get logger() {
        reads.logger += 1;
        return logger();
      },
      get timeoutMs() {
        reads.timeoutMs += 1;
        return 1_000;
      },
      get drainDelayMs() {
        reads.drainDelayMs += 1;
        if (reads.drainDelayMs > 1) {
          throw new Error("drainDelayMs read more than once");
        }
        return 25;
      },
      get beginDrain() {
        reads.beginDrain += 1;
        return () => void calls.push("drain");
      },
      get sleep() {
        reads.sleep += 1;
        return async (delayMs: number) => void calls.push(`sleep:${delayMs}`);
      },
    } satisfies GracefulShutdownOptions;

    const coordinator = new GracefulShutdownCoordinator(runtimeOptions);
    await coordinator.shutdown("SIGTERM");

    expect(reads).toEqual({
      server: 1,
      lifecycle: 1,
      logger: 1,
      timeoutMs: 1,
      drainDelayMs: 1,
      beginDrain: 1,
      sleep: 1,
    });
    expect(calls).toEqual(["drain", "sleep:25", "stop:false", "close"]);
  });

  test("requires explicitly configured shutdown hooks to be callable", () => {
    const server = { stop: mock(async () => undefined) };
    const lifecycle = { close: mock(async () => undefined) };
    const base = {
      server,
      lifecycle,
      logger: logger(),
      timeoutMs: 1_000,
    };

    expect(
      () =>
        new GracefulShutdownCoordinator({
          ...base,
          beginDrain: null,
        } as unknown as GracefulShutdownOptions),
    ).toThrow("GracefulShutdownCoordinator beginDrain must be callable");

    expect(
      () =>
        new GracefulShutdownCoordinator({
          ...base,
          sleep: null,
        } as unknown as GracefulShutdownOptions),
    ).toThrow("GracefulShutdownCoordinator sleep must be callable");
  });

  test("forces active connections closed after the graceful deadline", async () => {
    let first = true;
    const server = {
      stop: mock(async (force?: boolean) => {
        if (!force && first) {
          first = false;
          await new Promise<never>(() => undefined);
        }
      }),
    };
    const lifecycle = { close: mock(async () => undefined) };
    const coordinator = new GracefulShutdownCoordinator({
      server,
      lifecycle,
      logger: logger(),
      timeoutMs: 0,
    });

    await coordinator.shutdown("SIGTERM");

    expect(server.stop).toHaveBeenNthCalledWith(1, false);
    expect(server.stop).toHaveBeenNthCalledWith(2, true);
    expect(lifecycle.close).toHaveBeenCalledTimes(1);
  });

  test("logging failures do not interrupt shutdown control flow", async () => {
    const calls: string[] = [];
    const server = {
      stop: mock(async (force?: boolean) => {
        calls.push(`stop:${String(force)}`);
        if (!force) {
          await new Promise<never>(() => undefined);
        }
      }),
    };
    const lifecycle = {
      close: mock(async () => void calls.push("close")),
    };
    const failingLogger = new JsonConsoleLogger({ service: "test" }, () => {
      throw new Error("logger unavailable");
    });
    const coordinator = new GracefulShutdownCoordinator({
      server,
      lifecycle,
      logger: failingLogger,
      timeoutMs: 0,
      drainDelayMs: 25,
      beginDrain: () => void calls.push("drain"),
      sleep: async (delayMs) => void calls.push(`sleep:${delayMs}`),
    });

    await coordinator.shutdown("SIGTERM");

    expect(calls).toEqual(["drain", "sleep:25", "stop:false", "stop:true", "close"]);
  });

  test("is idempotent when multiple signals arrive", async () => {
    const server = { stop: mock(async () => undefined) };
    const lifecycle = { close: mock(async () => undefined) };
    const coordinator = new GracefulShutdownCoordinator({
      server,
      lifecycle,
      logger: logger(),
      timeoutMs: 1_000,
    });

    await Promise.all([coordinator.shutdown("SIGINT"), coordinator.shutdown("SIGTERM")]);

    expect(server.stop).toHaveBeenCalledTimes(1);
    expect(lifecycle.close).toHaveBeenCalledTimes(1);
  });
});
