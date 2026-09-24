CREATE INDEX "user_creation_idempotency_expires_cleanup_idx" ON "user_creation_idempotency" USING btree ("expires_at","tenant_id","key_hash");
