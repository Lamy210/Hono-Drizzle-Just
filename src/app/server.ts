import { loadConfig } from "../config/load-config";
import { resolveBunRemoteAddress } from "../http/bun/remote-address";
import { createApp } from "./app";
import { createProductionContainer } from "./composition/container";
import { GracefulShutdownCoordinator } from "./lifecycle/graceful-shutdown";
import { createBunServerOptions } from "./server-options";

const config = loadConfig(Bun.env);
const container = createProductionContainer(config);
const app = createApp(container.dependencies, {
  maxRequestBodyBytes: config.httpMaxRequestBodyBytes,
  remoteAddressResolver: resolveBunRemoteAddress,
});
const server = Bun.serve(
  createBunServerOptions({
    port: config.port,
    fetch: app.fetch,
    maxRequestBodySize: config.httpTransportMaxRequestBodyBytes,
  }),
);
const shutdown = new GracefulShutdownCoordinator({
  server,
  lifecycle: container.lifecycle,
  logger: container.dependencies.logger,
  timeoutMs: config.shutdownTimeoutMs,
});

container.dependencies.logger.info("server.started", { port: server.port });

function handleSignal(signal: "SIGINT" | "SIGTERM"): void {
  void shutdown
    .shutdown(signal)
    .then(() => {
      process.exitCode = 0;
    })
    .catch((error) => {
      container.dependencies.logger.error("server.shutdown.failed", { signal, error });
      process.exit(1);
    });
}

process.on("SIGINT", () => handleSignal("SIGINT"));
process.on("SIGTERM", () => handleSignal("SIGTERM"));
