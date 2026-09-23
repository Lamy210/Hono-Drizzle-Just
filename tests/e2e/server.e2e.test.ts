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

interface UserListResponse {
  readonly data: readonly UserResponse[];
  readonly meta: {
    readonly page: number;
    readonly perPage: number;
    readonly total: number;
    readonly totalPages: number;
  };
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
        const createdEtag = createdResponse.headers.get("etag");
        expect(createdEtag).toBe('"v1"');
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
        expect(fetchedResponse.headers.get("etag")).toBe(createdEtag);
        expect((await fetchedResponse.json()) as UserResponse).toEqual(created);

        const notModifiedResponse = await boundedFetch(`${baseUrl}/users/${created.id}`, {
          headers: {
            authorization,
            "if-none-match": createdEtag ?? "",
          },
        });
        expect(notModifiedResponse.status).toBe(304);
        expect(notModifiedResponse.headers.get("etag")).toBe(createdEtag);
        expect(await notModifiedResponse.text()).toBe("");

        const listResponse = await boundedFetch(`${baseUrl}/users?page=1&perPage=20`, {
          headers: { authorization },
        });
        expect(listResponse.status).toBe(200);
        const listed = (await listResponse.json()) as UserListResponse;
        expect(listed.data.some((user) => user.id === created.id)).toBe(true);
        expect(listed.meta).toMatchObject({ page: 1, perPage: 20, total: 1, totalPages: 1 });

        const updateResponse = await boundedFetch(`${baseUrl}/users/${created.id}`, {
          method: "PATCH",
          headers: {
            ...authenticatedHeaders(authorization),
            "if-match": createdEtag ?? "",
          },
          body: JSON.stringify({
            name: "Tenant A Updated",
            tenantId: "tenant-B",
          }),
        });
        expect(updateResponse.status).toBe(200);
        const updatedEtag = updateResponse.headers.get("etag");
        expect(updatedEtag).toBe('"v2"');
        const updated = (await updateResponse.json()) as UserResponse;
        expect(updated).toEqual({ ...created, name: "Tenant A Updated" });
        expect("tenantId" in updated).toBe(false);

        const revalidatedWithOldTag = await boundedFetch(`${baseUrl}/users/${created.id}`, {
          headers: {
            authorization,
            "if-none-match": createdEtag ?? "",
          },
        });
        expect(revalidatedWithOldTag.status).toBe(200);
        expect(revalidatedWithOldTag.headers.get("etag")).toBe(updatedEtag);
        expect((await revalidatedWithOldTag.json()) as UserResponse).toEqual(updated);

        const weakCurrentTag = updatedEtag ? `W/${updatedEtag}` : "";
        const revalidatedWithWeakCurrentTag = await boundedFetch(
          `${baseUrl}/users/${created.id}`,
          {
            headers: {
              authorization,
              "if-none-match": weakCurrentTag,
            },
          },
        );
        expect(revalidatedWithWeakCurrentTag.status).toBe(304);
        expect(revalidatedWithWeakCurrentTag.headers.get("etag")).toBe(updatedEtag);

        const staleUpdateResponse = await boundedFetch(`${baseUrl}/users/${created.id}`, {
          method: "PATCH",
          headers: {
            ...authenticatedHeaders(authorization),
            "if-match": createdEtag ?? "",
          },
          body: JSON.stringify({ name: "Stale overwrite" }),
        });
        expect(staleUpdateResponse.status).toBe(412);
        expect(await staleUpdateResponse.json()).toMatchObject({
          error: { code: "PRECONDITION_FAILED" },
        });

        const staleDeleteResponse = await boundedFetch(`${baseUrl}/users/${created.id}`, {
          method: "DELETE",
          headers: {
            authorization,
            "if-match": createdEtag ?? "",
          },
        });
        expect(staleDeleteResponse.status).toBe(412);
        expect(await staleDeleteResponse.json()).toMatchObject({
          error: { code: "PRECONDITION_FAILED" },
        });

        const idempotencyKey = crypto.randomUUID();
        const idempotentEmail = `e2e-idempotent-${crypto.randomUUID()}@example.com`;
        const idempotentHeaders = {
          ...authenticatedHeaders(authorization),
          "idempotency-key": idempotencyKey,
        };

        const firstIdempotentResponse = await boundedFetch(`${baseUrl}/users`, {
          method: "POST",
          headers: idempotentHeaders,
          body: JSON.stringify({
            email: idempotentEmail.toUpperCase(),
            name: "Idempotent User",
          }),
        });
        expect(firstIdempotentResponse.status).toBe(201);
        const firstIdempotentEtag = firstIdempotentResponse.headers.get("etag");
        expect(firstIdempotentEtag).toBe('"v1"');
        const firstIdempotent = (await firstIdempotentResponse.json()) as UserResponse;

        const replayResponse = await boundedFetch(`${baseUrl}/users`, {
          method: "POST",
          headers: idempotentHeaders,
          body: JSON.stringify({
            email: idempotentEmail,
            name: "Idempotent User",
          }),
        });
        expect(replayResponse.status).toBe(201);
        const replay = (await replayResponse.json()) as UserResponse;
        expect(replay.id).toBe(firstIdempotent.id);
        expect(replay).toEqual(firstIdempotent);

        const updateConflictResponse = await boundedFetch(`${baseUrl}/users/${created.id}`, {
          method: "PATCH",
          headers: {
            ...authenticatedHeaders(authorization),
            "if-match": updatedEtag ?? "",
          },
          body: JSON.stringify({ email: idempotentEmail }),
        });
        expect(updateConflictResponse.status).toBe(409);
        expect(await updateConflictResponse.json()).toMatchObject({
          error: { code: "CONFLICT" },
        });

        const mismatchResponse = await boundedFetch(`${baseUrl}/users`, {
          method: "POST",
          headers: idempotentHeaders,
          body: JSON.stringify({
            email: idempotentEmail,
            name: "Changed Idempotent User",
          }),
        });
        expect(mismatchResponse.status).toBe(422);
        const mismatchBody = await mismatchResponse.json();
        expect(mismatchBody).toMatchObject({
          error: { code: "IDEMPOTENCY_KEY_REUSED" },
        });
        expect(JSON.stringify(mismatchBody)).not.toContain(idempotencyKey);

        const deleteIdempotentResponse = await boundedFetch(
          `${baseUrl}/users/${firstIdempotent.id}`,
          {
            method: "DELETE",
            headers: {
              authorization,
              "if-match": firstIdempotentEtag ?? "",
            },
          },
        );
        expect(deleteIdempotentResponse.status).toBe(204);
        expect(await deleteIdempotentResponse.text()).toBe("");

        const recreateResponse = await boundedFetch(`${baseUrl}/users`, {
          method: "POST",
          headers: idempotentHeaders,
          body: JSON.stringify({
            email: idempotentEmail,
            name: "Idempotent User",
          }),
        });
        expect(recreateResponse.status).toBe(201);
        const recreated = (await recreateResponse.json()) as UserResponse;
        expect(recreated.id).not.toBe(firstIdempotent.id);

        return updated;
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

        const crossTenantUpdate = await boundedFetch(`${baseUrl}/users/${tenantAUser.id}`, {
          method: "PATCH",
          headers: {
            ...authenticatedHeaders(authorization),
            "if-match": "*",
          },
          body: JSON.stringify({ name: "Cross tenant update" }),
        });
        expect(crossTenantUpdate.status).toBe(404);
        expect(await crossTenantUpdate.json()).toMatchObject({
          error: { code: "NOT_FOUND" },
        });

        const crossTenantDelete = await boundedFetch(
          `${baseUrl}/users/${tenantAUser.id}`,
          {
            method: "DELETE",
            headers: {
              authorization,
              "if-match": "*",
            },
          },
        );
        expect(crossTenantDelete.status).toBe(404);
        expect(await crossTenantDelete.json()).toMatchObject({
          error: { code: "NOT_FOUND" },
        });

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

        const listResponse = await boundedFetch(`${baseUrl}/users`, {
          headers: { authorization },
        });
        expect(listResponse.status).toBe(200);
        const listed = (await listResponse.json()) as UserListResponse;
        expect(listed.data.some((user) => user.id === created.id)).toBe(true);
        expect(listed.data.some((user) => user.id === tenantAUser.id)).toBe(false);
        expect(listed.meta.total).toBe(1);

        return created;
      },
    );

    expect(tenantBUser.email).toBe(tenantAUser.email);
  },
  25_000,
);
