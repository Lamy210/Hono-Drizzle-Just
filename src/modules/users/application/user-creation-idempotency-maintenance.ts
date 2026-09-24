export interface UserCreationIdempotencyMaintenance {
  cleanupIfDue(): Promise<void>;
}
