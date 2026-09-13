import { eq } from "drizzle-orm";
import { AppError } from "../../../core/errors/app-error";
import { users } from "../../../db/schema";
import type { DatabaseSession } from "../../../infrastructure/database/database";
import type { CreateUserInput, User } from "../domain/user";
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

export class DrizzleUserRepository implements UserRepository {
  constructor(private readonly db: DatabaseSession) {}

  async findById(id: string): Promise<User | null> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return row ?? null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const [row] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    return row ?? null;
  }

  async create(input: CreateUserInput): Promise<User> {
    try {
      const [row] = await this.db.insert(users).values(input).returning();
      if (!row) {
        throw new Error("Insert returned no user");
      }
      return row;
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
