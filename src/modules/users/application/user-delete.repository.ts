export interface UserDeleteRepository {
  deleteById(tenantId: string, id: string): Promise<boolean>;
}
