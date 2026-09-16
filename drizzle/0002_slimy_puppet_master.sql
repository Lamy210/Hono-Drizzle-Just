CREATE TABLE "user_creation_idempotency" (
	"tenant_id" varchar(128) NOT NULL,
	"key_hash" char(64) NOT NULL,
	"request_fingerprint" char(64) NOT NULL,
	"user_id" uuid,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "user_creation_idempotency_tenant_id_key_hash_pk" PRIMARY KEY("tenant_id","key_hash")
);
--> statement-breakpoint
ALTER TABLE "user_creation_idempotency" ADD CONSTRAINT "user_creation_idempotency_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;