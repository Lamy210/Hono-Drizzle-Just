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

interface TenantServerConfig {
  readonly token: string;
  readonly subject: string;
  readonly tenantId: string;
  readonly scopes: readonly string[];
}

interface TenantServerClient {
  readonly baseUrl: string;
  readonly authorization: string;
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

async function withTenantServer<T>(
  config: TenantServerConfig,
  operation: (client: TenantServerClient) => Promise<T>,
): Promise<T> {
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
      AUTH_DEV_STATIC_ENABLED: "true",
      AUTH_DEV_STATIC_BEARER_TOKEN: config.token,
      AUTH_DEV_STATIC_SUBJECT: config.subject,
      AUTH_DEV_STATIC_TENANT_ID: config.tenantId,
      AUTH_DEV_STATIC_SCOPES: config.scopes.join(" "),
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
    const result = await operation({
      baseUrl,
      authorization: `Bearer ${config.token}`,
    });

    child.kill("SIGTERM");
    const exitCode = await withTimeout(child.exited, shutdownTimeoutMs, "server shutdown");
    if (exitCode !== 0) {
      throw new Error(`server exited with code ${exitCode} during graceful shutdown`);
    }

    const stdout = await stdoutPromise;
    const stderr = await stderrPromise;
    if (!stdout.includes('"message":"server.stopping"')) {
      throw new Error("server did not emit server.stopping during graceful shutdown");
    }
    if (!stdout.includes('"message":"server.stopped"')) {
      throw new Error("server did not emit server.stopped during graceful shutdown");
    }
    gracefulShutdownVerified = true;

    void stderr;
    return result;
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
}

function authenticatedHeaders(authorization: string): HeadersInit {
  return {
    authorization,
    "content-type": "application/json",
  };
}

test(
  "production server enforces tenant isolation across sequential authenticated processes",
  async () => {
    const email = `e2e-${crypto.randomUUID()}@example.com`;
    const tenantAToken = "e2e-tenant-a-token-0123456789abcdef";
    const tenantBToken = "e2e-tenant-b-token-0123456789abcdef";

    const tenantAUser = await withTenantServer(
      {
        token: tenantAToken,
        subject: "e2e-tenant-a-user",
        tenantId: "tenant-A",
        scopes: ["users:read", "users:write"],
      },
      async ({ baseUrl, authorization }) => {
        const live = await boundedFetch(`${baseUrl}/health/live`);
        expect(live.status).toBe(200);
        expect(await live.json()).toEqual({ status: "ok" });

        const ready = await boundedFetch(`${baseUrl}/health/ready`);
        expect(ready.status).toBe(200);
        expect((await ready.json() as { status: string }).status).toBe("ready");

        const anonymous = await boundedFetch(`${baseUrl}/users/${crypto.randomUUID()}`);
        expect(anonymous.status).toBe(401);

        const createdResponse = await boundedFetch(`${baseUrl}/users`, {
          method: "POST",
          headers: authenticatedHeaders(authorization),
          body: JSON.stringify({
            email,
            name: "Tenant A User",
            tenantId: "tenant-B",
          }),
        });
        expect(createdResponse.status).toBe(201);
        const created = (await createdResponse.json()) as UserResponse;
        expect(created.email).toBe(email);
        expect(created.name).toBe("Tenant A User");
        expect(created.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        expect(Number.isNaN(Date.parse(created.createdAt))).toBe(false);
        expect("tenantId" in created).toBe(false);

        const fetchedResponse = await boundedFetch(`${baseUrl}/users/${created.id}`, {
          headers: { authorization },
        });
        expect(fetchedResponse.status).toBe(200);
        expect((await fetchedResponse.json()) as UserResponse).toEqual(created);

        return created;
      },
    );

    const tenantBUser = await withTenantServer(
      {
        token: tenantBToken,
        subject: "e2e-tenant-b-user",
        tenantId: "tenant-B",
        scopes: ["users:read", "users:write"],
      },
      async ({ baseUrl, authorization }) => {
        const crossTenant = await boundedFetch(`${baseUrl}/users/${tenantAUser.id}`, {
          headers: { authorization },
        });
        expect(crossTenant.status).toBe(404);
        expect(await crossTenant.json()).toMatchObject({ error: { code: "NOT_FOUND" } });

        const createdResponse = await boundedFetch(`${baseUrl}/users`, {
          method: "POST",
          headers: authenticatedHeaders(authorization),
          body: JSON.stringify({ email, name: "Tenant B User" }),
        });
        expect(createdResponse.status).toBe(201);
        const created = (await createdResponse.json()) as UserResponse;
        expect(created.email).toBe(email);
        expect(created.name).toBe("Tenant B User");
        expect(created.id).not.toBe(tenantAUser.id);

        const fetchedResponse = await boundedFetch(`${baseUrl}/users/${created.id}`, {
          headers: { authorization },
        });
        expect(fetchedResponse.status).toBe(200);
        expect((await fetchedResponse.json()) as UserResponse).toEqual(created);

        return created;
      },
    );

    expect(tenantBUser.email).toBe(tenantAUser.email);
  },
  25_000,
);
