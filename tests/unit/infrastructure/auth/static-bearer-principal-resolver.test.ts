import { expect, test } from "bun:test";
import { StaticBearerPrincipalResolver } from "../../../../src/infrastructure/auth/static-bearer-principal-resolver";

const token = "0123456789abcdef0123456789abcdef";
const resolver = new StaticBearerPrincipalResolver({
  token,
  subject: "test-user",
  tenantId: "tenant-a",
  scopes: ["users:read", "users:write"],
});

test("absent Authorization leaves the request anonymous", async () => {
  expect(await resolver.resolve({})).toBeUndefined();
});

test("malformed or incorrect credentials are rejected without token leakage", async () => {
  for (const authorization of ["Basic abc", "Bearer", "Bearer wrong-token"]) {
    try {
      await resolver.resolve({ authorization });
      throw new Error("expected resolver to reject credentials");
    } catch (error) {
      expect(error).toMatchObject({ code: "UNAUTHORIZED", status: 401 });
      expect(String(error)).not.toContain(token);
      expect(String(error)).not.toContain("wrong-token");
    }
  }
});

test("valid bearer credentials map only server-configured principal data", async () => {
  await expect(resolver.resolve({ authorization: `Bearer ${token}` })).resolves.toEqual({
    subject: "test-user",
    tenantId: "tenant-a",
    scopes: ["users:read", "users:write"],
  });
});

test("bearer auth scheme is case-insensitive while token matching stays exact", async () => {
  await expect(resolver.resolve({ authorization: `bearer ${token}` })).resolves.toMatchObject({
    tenantId: "tenant-a",
  });
  await expect(resolver.resolve({ authorization: `Bearer ${token.toUpperCase()}` })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});
