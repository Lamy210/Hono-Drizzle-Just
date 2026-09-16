import type { TenantScopedCreateUserInput, User } from "./user";

export interface UserRepository {
  findById(tenantId: string, id: string): Promise<User | null>;
  findByEmail(tenantId: string, email: string): Promise<User | null>;
  create(input: TenantScopedCreateUserInput): Promise<User>;
}
