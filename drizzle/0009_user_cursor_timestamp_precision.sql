ALTER TABLE "users"
ALTER COLUMN "created_at" TYPE timestamp(3) with time zone
USING date_trunc('milliseconds', "created_at");
