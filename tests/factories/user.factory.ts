import { users } from "../../src/db/schema";
import type { DatabaseSession } from "../../src/infrastructure/database/database";
import type { User } from "../../src/modules/users/domain/user";
import {
  type FactoryContext,
  PersistentTestFactory,
  TestFactory,
} from "./factory";

export type UserFactoryOverrides = Partial<User>;

function userDefaults({ sequence }: FactoryContext): User {
  return {
    id: crypto.randomUUID(),
    email: `user-${sequence}-${crypto.randomUUID()}@example.com`,
    name: `User ${sequence}`,
    createdAt: new Date("2026-09-13T00:00:00.000Z"),
  };
}

export function makeUserFactory(): TestFactory<User>;
export function makeUserFactory(db: DatabaseSession): PersistentTestFactory<User, User>;
export function makeUserFactory(
  db?: DatabaseSession,
): TestFactory<User> | PersistentTestFactory<User, User> {
  if (!db) {
    return new TestFactory(userDefaults);
  }

  return new PersistentTestFactory(userDefaults, async (values) => {
    const [created] = await db.insert(users).values(values).returning();
    if (!created) {
      throw new Error("User factory failed to persist a user");
    }
    return created;
  });
}
