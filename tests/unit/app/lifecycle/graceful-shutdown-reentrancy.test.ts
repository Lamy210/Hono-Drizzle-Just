import { expect, mock, test } from "bun:test";
import { GracefulShutdownCoordinator } from "../../../../src/app/lifecycle/graceful-shutdown";
import { JsonConsoleLogger } from "../../../../src/infrastructure/logging/json-console-logger";

function logger() {
  return new JsonConsoleLogger({ service: "test" }, () => undefined);
}

test("shares the in-flight shutdown promise with reentrant shutdown calls", async () => {
  const server = { stop: mock(async () => undefined) };
  const lifecycle = { close: mock(async () => undefined) };
  let coordinator!: GracefulShutdownCoordinator;
  let reentered = false;
  let reentrantShutdown: Promise<void> | undefined;

  coordinator = new GracefulShutdownCoordinator({
    server,
    lifecycle,
    logger: logger(),
    timeoutMs: 1_000,
    beginDrain: () => {
      if (!reentered) {
        reentered = true;
        reentrantShutdown = coordinator.shutdown("SIGINT");
      }
    },
  });

  const shutdown = coordinator.shutdown("SIGTERM");

  expect(reentrantShutdown).toBe(shutdown);
  await shutdown;
  expect(server.stop).toHaveBeenCalledTimes(1);
  expect(lifecycle.close).toHaveBeenCalledTimes(1);
});
