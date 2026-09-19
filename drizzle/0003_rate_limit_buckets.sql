CREATE TABLE "rate_limit_buckets" (
	"scope" varchar(100) NOT NULL,
	"identity_hash" char(64) NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_count" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rate_limit_buckets_scope_identity_hash_pk" PRIMARY KEY("scope","identity_hash")
);