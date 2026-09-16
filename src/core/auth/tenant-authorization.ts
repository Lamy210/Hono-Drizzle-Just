import type { RequestContext } from "../context/request-context";
import { AppError } from "../errors/app-error";

export const LEGACY_TENANT_PREFIX = "__legacy__:";

export interface TenantAuthorization {
  readonly subject: string;
  readonly tenantId: string;
}

export function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function isValidTenantId(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 128 &&
    value === value.trim() &&
    !hasControlCharacters(value) &&
    !value.startsWith(LEGACY_TENANT_PREFIX)
  );
}

export function requireTenantScope(
  context: RequestContext,
  requiredScope: string,
): TenantAuthorization {
  const principal = context.principal;
  if (!principal) {
    throw new AppError("UNAUTHORIZED", "Authentication required", 401);
  }

  if (!principal.tenantId || !isValidTenantId(principal.tenantId)) {
    throw new AppError("FORBIDDEN", "Access denied", 403);
  }

  if (!principal.scopes?.includes(requiredScope)) {
    throw new AppError("FORBIDDEN", "Access denied", 403);
  }

  return {
    subject: principal.subject,
    tenantId: principal.tenantId,
  };
}
