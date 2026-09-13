export interface Principal {
  readonly subject: string;
  readonly tenantId?: string;
  readonly roles?: readonly string[];
  readonly scopes?: readonly string[];
}
