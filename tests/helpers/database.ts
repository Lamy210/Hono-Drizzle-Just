import { createDatabase } from "../../src/infrastructure/database/database";

export function createTestDatabase() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required for integration tests");
  }
  return createDatabase({ connectionString: url });
}
