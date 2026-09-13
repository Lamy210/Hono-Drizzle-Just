import { describe, expect, mock, test } from "bun:test";
import { GracefulShutdownCoordinator } from "../../../../src/app/lifecycle/graceful-shutdown";
import { JsonConsoleLogger } from "../../../../src/infrastructure/logging/json-console-logger";

function logger() {
  return new JsonConsoleLogger({ service: "test" }, () => undefined);
}

describe("GracefulShutdownCoordinator", () => {
  test("waits for graceful server stop before closing resources", async () => {
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
    });

    await coordinator.shutdown("SIGTERM");

    expect(calls).toEqual(["stop:false", "close"]);
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
