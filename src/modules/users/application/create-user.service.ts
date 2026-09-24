import { requireTenantScope } from "../../../core/auth/tenant-authorization";
import type { StringDigester } from "../../../core/crypto/string-digester";
import type { RequestContext } from "../../../core/context/request-context";
import { AppError } from "../../../core/errors/app-error";
import type { Logger } from "../../../core/logging/logger";
import type { CreateUserInput, User } from "../domain/user";
import type { UserCreationIdempotencyMaintenance } from "./user-creation-idempotency-maintenance";
import type { UserTransactionManager } from "./user-unit-of-work";

const IDEMPOTENCY_TTL_SECONDS = 86_400;

interface CreateUserResult {
  readonly user: User;
  readonly created: boolean;
}

export class CreateUserService {
  constructor(
    private readonly transactions: UserTransactionManager,
    private readonly logger: Logger,
    private readonly digester: StringDigester,
    private readonly idempotencyMaintenance?: UserCreationIdempotencyMaintenance,
  ) {}

  async execute(
    input: CreateUserInput,
    context: RequestContext,
    options: { readonly idempotencyKey?: string } = {},
  ): Promise<User> {
    const { tenantId } = requireTenantScope(context, "users:write");
    const normalized = {
      email: input.email.trim().toLowerCase(),
      name: input.name.trim(),
    };

    const result = options.idempotencyKey
      ? await this.createIdempotently(options.idempotencyKey, tenantId, normalized)
      : {
          user: await this.transactions.run(
            async (unitOfWork) => {
              const existing = await unitOfWork.users.findByEmail(tenantId, normalized.email);
              if (existing) {
                throw new AppError("CONFLICT", "A user with this email already exists", 409);
              }
              return unitOfWork.users.create({ tenantId, ...normalized });
            },
            { retry: "safe" },
          ),
          created: true,
        };

    if (result.created) {
      this.logger.info("user.created", {
        userId: result.user.id,
        requestId: context.requestId,
        traceId: context.trace.traceId,
      });
    }
    return result.user;
  }

  private async createIdempotently(
    idempotencyKey: string,
    tenantId: string,
    normalized: { readonly email: string; readonly name: string },
  ): Promise<CreateUserResult> {
    await this.idempotencyMaintenance?.cleanupIfDue();

    const keyHash = this.digester.sha256Hex(idempotencyKey);
    const requestFingerprint = this.digester.sha256Hex(
      `users:create:v1\n${normalized.email}\n${normalized.name}`,
    );

    return this.transactions.run(
      async (unitOfWork) => {
        const claim = await unitOfWork.userCreationIdempotency.claim({
          tenantId,
          keyHash,
          requestFingerprint,
          ttlSeconds: IDEMPOTENCY_TTL_SECONDS,
        });

        if (claim.state === "existing") {
          if (claim.record.requestFingerprint !== requestFingerprint) {
            throw new AppError(
              "IDEMPOTENCY_KEY_REUSED",
              "Idempotency key was already used with a different request",
              422,
            );
          }
          if (!claim.record.userId) {
            throw new AppError("INTERNAL_ERROR", "Idempotency state is inconsistent", 500);
          }
          const replay = await unitOfWork.users.findById(tenantId, claim.record.userId);
          if (!replay) {
            throw new AppError("INTERNAL_ERROR", "Idempotency state is inconsistent", 500);
          }
          return { user: replay, created: false };
        }

        const existing = await unitOfWork.users.findByEmail(tenantId, normalized.email);
        if (existing) {
          throw new AppError("CONFLICT", "A user with this email already exists", 409);
        }

        const user = await unitOfWork.users.create({ tenantId, ...normalized });
        await unitOfWork.userCreationIdempotency.complete({
          tenantId,
          keyHash,
          requestFingerprint,
          userId: user.id,
        });
        return { user, created: true };
      },
      { retry: "safe" },
    );
  }
}
