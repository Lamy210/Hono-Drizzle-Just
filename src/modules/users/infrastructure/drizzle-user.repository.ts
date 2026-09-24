import { and, eq, sql, type SQL } from "drizzle-orm";
import { AppError } from "../../../core/errors/app-error";
import { users } from "../../../db/schema";
import type { DatabaseSession } from "../../../infrastructure/database/database";
import type { DatabaseObserver } from "../../../infrastructure/database/database-observer";
import type { UserDeleteRepository, UserDeleteResult } from "../application/user-delete.repository";
import type { UserListRepository } from "../application/user-list.repository";
import type {
  UserUpdateFields,
  UserUpdateRepository,
  UserUpdateResult,
} from "../application/user-update.repository";
import type { UserVersionPrecondition } from "../application/user-version-precondition";
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

function versionPreconditionSql(precondition: UserVersionPrecondition): SQL {
  if (precondition.kind === "any-current") {
    return sql`true`;
  }
  if (precondition.versions.length === 0) {
    return sql`false`;
  }

  return sql`${users.version} in (${sql.join(
    precondition.versions.map((version) => sql`${version}`),
    sql`, `,
  )})`;
}

interface DatabaseUserRow extends Record<string, unknown> {
  readonly id: string | null;
  readonly tenant_id: string | null;
  readonly email: string | null;
  readonly name: string | null;
  readonly version: number | null;
  readonly created_at: unknown;
}

interface AtomicUserUpdateRow extends DatabaseUserRow {
  readonly state: "updated" | "not_found" | "precondition_failed";
}

interface AtomicUserListRow extends DatabaseUserRow {
  readonly total: unknown;
}

interface AtomicUserDeleteRow extends Record<string, unknown> {
  readonly state: "deleted" | "not_found" | "precondition_failed";
}

function databaseDate(value: unknown): Date | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value;
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function userFromDatabaseRow(row: DatabaseUserRow, errorMessage: string): User {
  const createdAt = databaseDate(row.created_at);
  if (
    row.id === null ||
    row.tenant_id === null ||
    row.email === null ||
    row.name === null ||
    row.version === null ||
    createdAt === undefined
  ) {
    throw new Error(errorMessage);
  }

  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    name: row.name,
    version: row.version,
    createdAt,
  };
}

function databaseCount(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    const parsed = BigInt(value);
    if (parsed <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(parsed);
    }
  }
  throw new Error("Atomic user list returned an invalid total");
}

function updatedUserFromRow(row: AtomicUserUpdateRow): User {
  return userFromDatabaseRow(row, "Atomic user update returned an incomplete row");
}

export class DrizzleUserRepository implements UserRepository, UserListRepository, UserUpdateRepository, UserDeleteRepository {
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
    const execute = async (): Promise<{
      readonly users: readonly User[];
      readonly total: number;
    }> => {
      const result = await this.db.execute<AtomicUserListRow>(sql`
        with total as (
          select count(*)::text as total
          from ${users}
          where ${users.tenantId} = ${tenantId}
        ),
        page as (
          select
            ${users.id} as id,
            ${users.tenantId} as tenant_id,
            ${users.email} as email,
            ${users.name} as name,
            ${users.version} as version,
            ${users.createdAt} as created_at
          from ${users}
          where ${users.tenantId} = ${tenantId}
          order by ${users.createdAt} desc, ${users.id} desc
          limit ${input.limit}
          offset ${input.offset}
        )
        select
          page.id,
          page.tenant_id,
          page.email,
          page.name,
          page.version,
          page.created_at,
          total.total
        from total
        left join page on true
        order by page.created_at desc nulls last, page.id desc nulls last
      `);

      const first = result.rows[0];
      if (!first) {
        throw new Error("Atomic user list returned no total row");
      }

      const total = databaseCount(first.total);
      const page = result.rows
        .filter((row) => row.id !== null)
        .map((row) => userFromDatabaseRow(row, "Atomic user list returned an incomplete row"));

      return { users: page, total };
    };

    return this.observer
      ? this.observer.operation({ operation: "SELECT", collection: "users" }, execute)
      : execute();
  }

  async deleteById(
    tenantId: string,
    id: string,
    precondition: UserVersionPrecondition,
  ): Promise<UserDeleteResult> {
    const execute = async (): Promise<UserDeleteResult> => {
      const result = await this.db.execute<AtomicUserDeleteRow>(sql`
        with deleted as (
          delete from ${users}
          where
            ${users.tenantId} = ${tenantId}
            and ${users.id} = ${id}
            and ${versionPreconditionSql(precondition)}
          returning ${users.id} as id
        )
        select
          case
            when deleted.id is not null then 'deleted'
            when exists (
              select 1
              from ${users}
              where
                ${users.tenantId} = ${tenantId}
                and ${users.id} = ${id}
            ) then 'precondition_failed'
            else 'not_found'
          end as state
        from (select 1) as anchor
        left join deleted on true
        limit 1
      `);

      const row = result.rows[0];
      if (!row) {
        throw new Error("Atomic user delete returned no classification");
      }
      return { state: row.state };
    };

    return this.observer
      ? this.observer.operation({ operation: "DELETE", collection: "users" }, execute)
      : execute();
  }

  async update(
    tenantId: string,
    id: string,
    fields: UserUpdateFields,
    precondition: UserVersionPrecondition,
  ): Promise<UserUpdateResult> {
    const assignments: SQL[] = [];
    if (fields.email !== undefined) {
      assignments.push(sql`"email" = ${fields.email}`);
    }
    if (fields.name !== undefined) {
      assignments.push(sql`"name" = ${fields.name}`);
    }
    assignments.push(sql`"version" = ${users.version} + 1`);

    const execute = async (): Promise<UserUpdateResult> => {
      const result = await this.db.execute<AtomicUserUpdateRow>(sql`
        with updated as (
          update ${users}
          set ${sql.join(assignments, sql`, `)}
          where
            ${users.tenantId} = ${tenantId}
            and ${users.id} = ${id}
            and ${versionPreconditionSql(precondition)}
          returning
            ${users.id} as id,
            ${users.tenantId} as tenant_id,
            ${users.email} as email,
            ${users.name} as name,
            ${users.version} as version,
            ${users.createdAt} as created_at
        )
        select
          case
            when updated.id is not null then 'updated'
            when exists (
              select 1
              from ${users}
              where
                ${users.tenantId} = ${tenantId}
                and ${users.id} = ${id}
            ) then 'precondition_failed'
            else 'not_found'
          end as state,
          updated.id,
          updated.tenant_id,
          updated.email,
          updated.name,
          updated.version,
          updated.created_at
        from (select 1) as anchor
        left join updated on true
        limit 1
      `);

      const row = result.rows[0];
      if (!row) {
        throw new Error("Atomic user update returned no classification");
      }
      if (row.state !== "updated") {
        return { state: row.state };
      }
      return { state: "updated", user: updatedUserFromRow(row) };
    };

    try {
      return this.observer
        ? await this.observer.operation({ operation: "UPDATE", collection: "users" }, execute)
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
