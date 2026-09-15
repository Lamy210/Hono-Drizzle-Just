import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { getFreeLoopbackPort } from "./helpers/free-port";

const root = new URL("../../", import.meta.url);
const startupTimeoutMs = 10_000;
const requestTimeoutMs = 2_000;
const shutdownTimeoutMs = 5_000;

interface UserResponse {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly createdAt: string;
}

function requiredDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required for E2E tests");
  }
  return url;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    Bun.sleep(timeoutMs).then(() => {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }),
  ]);
}

async function boundedFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
}

async function waitUntilReady(baseUrl: string, child: Bun.Subprocess): Promise<void> {
  const deadline = Date.now() + startupTimeoutMs;
  let lastState = "not attempted";

  while (Date.now() < deadline) {
    const outcome = await Promise.race([
      child.exited.then((exitCode) => ({ kind: "exit" as const, exitCode })),
      Bun.sleep(100).then(() => ({ kind: "tick" as const })),
    ]);

    if (outcome.kind === "exit") {
      throw new Error(`server exited before readiness with code ${outcome.exitCode}`);
    }

    try {
      const response = await boundedFetch(`${baseUrl}/health/ready`);
      lastState = `HTTP ${response.status}`;
      if (response.status === 200) {
        return;
      }
    } catch (error) {
      lastState = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(`server did not become ready: ${lastState}`);
}

function failureWithLogs(error: unknown, stdout: string, stderr: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${message}\n--- child stdout ---\n${stdout}\n--- child stderr ---\n${stderr}`, {
    cause: error,
  });
}

test("production server serves a persisted user flow and shuts down on SIGTERM", async () => {
  const port = await getFreeLoopbackPort();
  const child = Bun.spawn({
    cmd: ["bun", "run", "start"],
    cwd: fileURLToPath(root),
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: requiredDatabaseUrl(),
      PORT: String(port),
      OTEL_ENABLED: "false",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  const baseUrl = `http://127.0.0.1:${port}`;
  let gracefulShutdownVerified = false;

  try {
    await waitUntilReady(baseUrl, child);

    const live = await boundedFetch(`${baseUrl}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: "ok" });

    const ready = await boundedFetch(`${baseUrl}/health/ready`);
    expect(ready.status).toBe(200);
    expect((await ready.json() as { status: string }).status).toBe("ready");

    const email = `e2e-${crypto.randomUUID()}@example.com`;
    const name = "E2E User";
    const createdResponse = await boundedFetch(`${baseUrl}/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, name }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as UserResponse;
    expect(created.email).toBe(email);
    expect(created.name).toBe(name);
    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(Number.isNaN(Date.parse(created.createdAt))).toBe(false);

    const fetchedResponse = await boundedFetch(`${baseUrl}/users/${created.id}`);
    expect(fetchedResponse.status).toBe(200);
    const fetched = (await fetchedResponse.json()) as UserResponse;
    expect(fetched).toEqual(created);

    child.kill("SIGTERM");
    const exitCode = await withTimeout(child.exited, shutdownTimeoutMs, "server shutdown");
    expect(exitCode).toBe(0);

    const stdout = await stdoutPromise;
    const stderr = await stderrPromise;
    expect(stdout).toContain('"message":"server.stopping"');
    expect(stdout).toContain('"message":"server.stopped"');
    gracefulShutdownVerified = true;

    void stderr;
  } catch (error) {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    throw failureWithLogs(error, await stdoutPromise, await stderrPromise);
  } finally {
    if (!gracefulShutdownVerified && child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
});
