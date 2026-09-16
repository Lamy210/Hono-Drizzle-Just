import { timingSafeEqual } from "node:crypto";
import type {
  PrincipalResolutionInput,
  PrincipalResolver,
} from "../../core/auth/principal-resolver";
import type { Principal } from "../../core/auth/principal";
import { AppError } from "../../core/errors/app-error";

export interface StaticBearerPrincipalResolverOptions {
  readonly token: string;
  readonly subject: string;
  readonly tenantId: string;
  readonly scopes: readonly string[];
}

function constantTimeTokenMatch(expectedToken: string, providedToken: string): boolean {
  const expected = Buffer.from(expectedToken, "utf8");
  const provided = Buffer.from(providedToken, "utf8");
  if (provided.length === expected.length) {
    return timingSafeEqual(expected, provided);
  }

  const normalized = Buffer.alloc(expected.length);
  provided.copy(normalized, 0, 0, Math.min(provided.length, expected.length));
  timingSafeEqual(expected, normalized);
  return false;
}

export class StaticBearerPrincipalResolver implements PrincipalResolver {
  constructor(private readonly options: StaticBearerPrincipalResolverOptions) {}

  async resolve(input: PrincipalResolutionInput): Promise<Principal | undefined> {
    if (input.authorization === undefined) {
      return undefined;
    }

    const match = /^Bearer ([^\s]+)$/i.exec(input.authorization);
    if (!match?.[1] || !constantTimeTokenMatch(this.options.token, match[1])) {
      throw new AppError("UNAUTHORIZED", "Invalid authentication credentials", 401);
    }

    return {
      subject: this.options.subject,
      tenantId: this.options.tenantId,
      scopes: [...this.options.scopes],
    };
  }
}
