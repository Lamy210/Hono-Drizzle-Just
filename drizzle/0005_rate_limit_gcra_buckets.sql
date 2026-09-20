CREATE TABLE "rate_limit_gcra_buckets" (
	"scope" varchar(100) NOT NULL,
	"identity_hash" char(64) NOT NULL,
	"theoretical_arrival_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rate_limit_gcra_buckets_scope_identity_hash_pk" PRIMARY KEY("scope","identity_hash")
);
--> statement-breakpoint
CREATE INDEX "rate_limit_gcra_buckets_expires_at_scope_identity_hash_idx" ON "rate_limit_gcra_buckets" USING btree ("expires_at","scope","identity_hash");