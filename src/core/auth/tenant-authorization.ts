import type { RequestContext } from "../context/request-context";
import { AppError } from "../errors/app-error";

export const LEGACY_TENANT_PREFIX = "__legacy__:";

const tenantControlCharacterPattern = /[\u0000-\u001f\u007f]/;

export interface TenantAuthorization {
  readonly subject: string;
  readonly tenantId: string;
}

export function isValidTenantId(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 128 &&
    value === value.trim() &&
    !tenantControlCharacterPattern.test(value) &&
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
