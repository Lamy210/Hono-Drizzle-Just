import { and, count, desc, eq } from "drizzle-orm";
import { AppError } from "../../../core/errors/app-error";
import { users } from "../../../db/schema";
import type { DatabaseSession } from "../../../infrastructure/database/database";
import type { DatabaseObserver } from "../../../infrastructure/database/database-observer";
import type { UserListRepository } from "../application/user-list.repository";
import type { TenantScopedCreateUserInput, User } from "../domain/user";
import type { UserRepository } from "../domain/user.repository";

function hasErrorCode(error: unknown, code: string): boolean {
  const visited = new Set<object>();
  let current: unknown = error;

  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    if ("code" in current && current.code === code) {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }

  return false;
}

function isUniqueViolation(error: unknown): boolean {
  return hasErrorCode(error, "23505");
}

export class DrizzleUserRepository implements UserRepository, UserListRepository {
  constructor(
    private readonly db: DatabaseSession,
    private readonly observer?: DatabaseObserver,
  ) {}

  async findById(tenantId: string, id: string): Promise<User | null> {
    const execute = async (): Promise<User | null> => {
      const [row] = await this.db
        .select()
        .from(users)
        .where(and(eq(users.tenantId, tenantId), eq(users.id, id)))
        .limit(1);
      return row ?? null;
    };

    return this.observer
      ? this.observer.operation({ operation: "SELECT", collection: "users" }, execute)
      : execute();
  }

  async findByEmail(tenantId: string, email: string): Promise<User | null> {
    const execute = async (): Promise<User | null> => {
      const [row] = await this.db
        .select()
        .from(users)
        .where(and(eq(users.tenantId, tenantId), eq(users.email, email)))
        .limit(1);
      return row ?? null;
    };

    return this.observer
      ? this.observer.operation({ operation: "SELECT", collection: "users" }, execute)
      : execute();
  }

  async listPage(
    tenantId: string,
    input: { readonly offset: number; readonly limit: number },
  ): Promise<{ readonly users: readonly User[]; readonly total: number }> {
    const countPage = async (): Promise<number> => {
      const [row] = await this.db
        .select({ total: count() })
        .from(users)
        .where(eq(users.tenantId, tenantId));
      return row?.total ?? 0;
    };
    const total = this.observer
      ? await this.observer.operation({ operation: "SELECT", collection: "users" }, countPage)
      : await countPage();

    if (input.offset >= total) {
      return { users: [], total };
    }

    const selectPage = async (): Promise<readonly User[]> => {
      return this.db
        .select()
        .from(users)
        .where(eq(users.tenantId, tenantId))
        .orderBy(desc(users.createdAt), desc(users.id))
        .limit(input.limit)
        .offset(input.offset);
    };
    const page = this.observer
      ? await this.observer.operation({ operation: "SELECT", collection: "users" }, selectPage)
      : await selectPage();

    return { users: page, total };
  }

  async create(input: TenantScopedCreateUserInput): Promise<User> {
    const execute = async (): Promise<User> => {
      const [row] = await this.db.insert(users).values(input).returning();
      if (!row) {
        throw new Error("Insert returned no user");
      }
      return row;
    };

    try {
      return this.observer
        ? await this.observer.operation({ operation: "INSERT", collection: "users" }, execute)
        : await execute();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError("CONFLICT", "A user with this email already exists", 409, undefined, {
          cause: error,
        });
      }
      throw error;
    }
  }
}
