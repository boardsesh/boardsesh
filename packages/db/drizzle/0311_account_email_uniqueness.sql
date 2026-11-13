-- Owner prerequisite: build users_email_lower_key CONCURRENTLY outside the migrator,
-- then add and validate users_email_normalized out of band (owner runbook #7430).
-- Keep BA-02 PR 5 DRAFT until both are valid: a plain build on hot users blocks writes.
-- NOT VALID preserves existing mixed-case dev fixtures; new writes must be normalized.
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_lower_key" ON "users" USING btree (lower("email"));--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"users"'::regclass AND conname = 'users_email_normalized'
  ) THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_email_normalized" CHECK ("users"."email" = pg_catalog.lower(pg_catalog.btrim("users"."email", U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'))) NOT VALID;
  END IF;
END $$;
