import { expect, test } from "bun:test";
import { z } from "zod";
import {
  FetchHttpClient,
  type FetchLike,
} from "../../../src/infrastructure/http/fetch-http-client";
import { DefaultRetryPolicy } from "../../../src/infrastructure/http/retry-policy";
import { JsonConsoleLogger } from "../../../src/infrastructure/logging/json-console-logger";

test("retry and response logs keep upstream paths and resource identifiers out of structured context", async () => {
  let attempts = 0;
  const lines: string[] = [];
  const fetchImpl: FetchLike = async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response("busy", { status: 503 });
    }
    return Response.json({ ok: true });
  };
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, (line) => lines.push(line)),
    fetchImpl,
    retryPolicy: new DefaultRetryPolicy({ baseDelayMs: 100, random: () => 0.5 }),
    sleep: async () => undefined,
  });
  const resourceId = "550e8400-e29b-41d4-a716-446655440000";

  await client.request(
    { method: "GET", path: `/resource/${resourceId}` },
    z.object({ ok: z.boolean() }),
  );

  const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(records).toHaveLength(2);
  expect(records).toContainEqual(
    expect.objectContaining({
      level: "warn",
      message: "http.client.retry",
      method: "GET",
      statusCode: 503,
      attempt: 1,
      nextAttempt: 2,
      delayMs: 50,
      reason: "status",
      upstreamHost: "example.test",
    }),
  );
  expect(records).toContainEqual(
    expect.objectContaining({
      level: "info",
      message: "http.client.response",
      method: "GET",
      statusCode: 200,
      attempt: 2,
      upstreamHost: "example.test",
    }),
  );

  for (const record of records) {
    expect(record.path).toBeUndefined();
  }
  expect(lines.join("\n")).not.toContain(resourceId);
  expect(lines.join("\n")).not.toContain("/resource/");
});
