import { expect, test } from "bun:test";
import {
  isValidTenantId,
  requireTenantScope,
} from "../../../../src/core/auth/tenant-authorization";
import type { RequestContext } from "../../../../src/core/context/request-context";

const baseContext: RequestContext = {
  requestId: "550e8400-e29b-41d4-a716-446655440000",
  trace: {
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    traceFlags: "01",
  },
  startedAt: 0,
};

function authenticated(
  tenantId: string | undefined,
  scopes: readonly string[],
): RequestContext {
  return {
    ...baseContext,
    principal: {
      subject: "user-123",
      ...(tenantId === undefined ? {} : { tenantId }),
      scopes,
    },
  };
}

test("tenant IDs are opaque, case-sensitive, normalized strings", () => {
  expect(isValidTenantId("Tenant-A")).toBe(true);
  expect(isValidTenantId("tenant:org_123.example")).toBe(true);
  expect(isValidTenantId("")).toBe(false);
  expect(isValidTenantId(" tenant-a")).toBe(false);
  expect(isValidTenantId("tenant-a ")).toBe(false);
  expect(isValidTenantId("tenant\n-a")).toBe(false);
  expect(isValidTenantId("x".repeat(129))).toBe(false);
  expect(isValidTenantId("__legacy__:550e8400-e29b-41d4-a716-446655440000")).toBe(false);
});

test("anonymous callers receive sanitized 401", () => {
  try {
    requireTenantScope(baseContext, "users:read");
    throw new Error("expected authorization to fail");
  } catch (error) {
    expect(error).toMatchObject({ code: "UNAUTHORIZED", status: 401 });
    expect(String(error)).not.toContain("users:read");
  }
});

test("missing, malformed, and reserved tenant contexts receive sanitized 403", () => {
  for (const tenantId of [undefined, " tenant-a", "tenant\u0000a", "__legacy__:123"]) {
    try {
      requireTenantScope(authenticated(tenantId, ["users:read"]), "users:read");
      throw new Error("expected authorization to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "FORBIDDEN", status: 403 });
      expect(String(error)).not.toContain("users:read");
    }
  }
});

test("missing scope receives 403 without disclosing the policy vocabulary", () => {
  try {
    requireTenantScope(authenticated("tenant-a", ["users:write"]), "users:read");
    throw new Error("expected authorization to fail");
  } catch (error) {
    expect(error).toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(String(error)).not.toContain("users:read");
  }
});

test("authorized tenant scope preserves the opaque tenant identifier", () => {
  expect(requireTenantScope(authenticated("Tenant-A", ["users:read"]), "users:read")).toEqual({
    subject: "user-123",
    tenantId: "Tenant-A",
  });
});
