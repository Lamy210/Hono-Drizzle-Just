export interface User {
  readonly id: string;
  readonly tenantId: string;
  readonly email: string;
  readonly name: string;
  readonly createdAt: Date;
}

export interface CreateUserInput {
  readonly email: string;
  readonly name: string;
}

export interface TenantScopedCreateUserInput extends CreateUserInput {
  readonly tenantId: string;
}
