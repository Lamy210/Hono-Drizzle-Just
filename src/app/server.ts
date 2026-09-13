import { createApp } from "./app";
import { createProductionContainer } from "./composition/container";

const container = createProductionContainer();
const app = createApp(container.dependencies);
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const server = Bun.serve({ port, fetch: app.fetch });

container.dependencies.logger.info("server.started", { port: server.port });

async function shutdown(signal: string): Promise<void> {
  container.dependencies.logger.info("server.stopping", { signal });
  server.stop();
  await container.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
