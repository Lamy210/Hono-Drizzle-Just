ALTER TABLE "users" ADD COLUMN "tenant_id" varchar(128);
UPDATE "users" SET "tenant_id" = '__legacy__:' || "id"::text WHERE "tenant_id" IS NULL;
ALTER TABLE "users" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "users" DROP CONSTRAINT "users_email_unique";
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_email_unique" UNIQUE("tenant_id","email");
