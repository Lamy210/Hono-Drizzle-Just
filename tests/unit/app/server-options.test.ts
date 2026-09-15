import { expect, test } from "bun:test";
import { createBunServerOptions } from "../../../src/app/server-options";

test("Bun server options include the configured request body hard cap", () => {
  const fetchHandler = async () => new Response("ok");
  const options = createBunServerOptions({
    port: 3000,
    fetch: fetchHandler,
    maxRequestBodySize: 2_097_152,
  });

  expect((options as { maxRequestBodySize?: number }).maxRequestBodySize).toBe(2_097_152);
  expect(options.port).toBe(3000);
  expect(options.fetch).toBe(fetchHandler);
});
