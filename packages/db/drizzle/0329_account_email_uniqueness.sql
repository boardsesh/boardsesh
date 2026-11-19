-- One account per email address regardless of case, stored in normalized form.
--
-- OUT OF BAND IN PRODUCTION (owner runbook #7430). users is written on every
-- sign-in and the migrator runs inside one transaction, so building the unique
-- index here would block every users write for the whole build. The owner builds
-- users_email_lower_key with CREATE UNIQUE INDEX CONCURRENTLY, then adds and
-- validates users_email_normalized. Keep BA-02 PR 5 a DRAFT until both exist and
-- are valid in production. There, both statements below find their object and
-- only verify it; a fresh dev, test or CI database builds both here.
--
-- IF NOT EXISTS matches the name only. A failed CONCURRENTLY build leaves an
-- INVALID index under the same name, and a hand-made index or constraint can carry
-- the name with another definition. Either would let this migration record success
-- with no uniqueness enforced, so each object is checked after the create and any
-- mismatch fails the migration.
--
-- VALIDATED WHEREVER IT CAN BE. When this migration adds the check, it validates it
-- too unless a stored email is not normalized. A fresh CI or dev-image database
-- therefore ends with the same validated check production gets from the runbook,
-- so one pinned users shape (the credential writer's receipt) can match both.
--
-- A database that keeps NOT VALID is one with legacy rows: dev volumes seeded
-- before this migration carry mixed-case faker users at fake.boardsesh.com, which
-- have no password or provider login. NOT VALID skips the scan of existing rows and
-- nothing else: Postgres checks the constraint on every INSERT and on every UPDATE
-- of a row, whichever column the UPDATE sets. Such a row can still be read and
-- deleted, but any UPDATE of it (a verify-email or OAuth verified stamp, a password
-- reset) fails with 23514 until its email is normalized. Production has no such
-- row: the owner's audit counts zero and VALIDATE proves it.
-- `docker compose down -v && vp run db:up` replaces a dev volume with normalized rows.
--
-- LOCKS. CREATE INDEX takes SHARE on users (blocks writes, not reads) even when the
-- index already exists, and ADD CONSTRAINT takes ACCESS EXCLUSIVE; both are held
-- until the migrator commits. The 3 s lock_timeout, the attempt length 0144, 0220
-- and 0302 use, makes a blocked deploy fail and roll back instead of queueing every
-- users query behind it. Re-run the deploy once the blocker is gone. The setting
-- goes back to its default before the next migration in the same run.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_lower_key" ON "users" USING btree (lower("email"));--> statement-breakpoint
DO $users_email_lower_key_guard$
DECLARE
  expected_definition text;
  found_definition text;
  found_usable boolean;
BEGIN
  -- pg_get_indexdef always schema-qualifies the table (checked on PG 15 and 18).
  SELECT pg_catalog.format(
    'CREATE UNIQUE INDEX users_email_lower_key ON %I.%I USING btree (lower(email))',
    table_namespace.nspname,
    table_class.relname
  )
  INTO expected_definition
  FROM pg_catalog.pg_class table_class
  JOIN pg_catalog.pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
  WHERE table_class.oid = '"users"'::regclass;

  -- The definition spells out everything that could weaken the key: UNIQUE, every
  -- key and INCLUDE column, operator class, collation and any WHERE predicate.
  -- Validity is not in it, so the build-state flags are read beside it.
  SELECT
    pg_catalog.pg_get_indexdef(index_entry.indexrelid),
    index_entry.indisvalid AND index_entry.indisready AND index_entry.indislive
  INTO found_definition, found_usable
  FROM pg_catalog.pg_class index_class
  JOIN pg_catalog.pg_index index_entry ON index_entry.indexrelid = index_class.oid
  WHERE index_class.relname = 'users_email_lower_key'
    AND index_class.relnamespace = (
      SELECT relnamespace FROM pg_catalog.pg_class WHERE oid = '"users"'::regclass
    )
    AND index_entry.indrelid = '"users"'::regclass;

  IF found_definition IS DISTINCT FROM expected_definition OR found_usable IS NOT TRUE THEN
    RAISE EXCEPTION 'users_email_lower_key is not a valid unique index on lower(email) of users'
      USING
        DETAIL = pg_catalog.format(
          'Found %s; usable: %s.',
          coalesce(found_definition, 'no index of that name on users'),
          coalesce(found_usable::text, 'n/a')
        ),
        HINT = 'Run DROP INDEX CONCURRENTLY "users_email_lower_key", rebuild it CONCURRENTLY '
          || '(owner runbook #7430), then re-run the migration.';
  END IF;
END $users_email_lower_key_guard$;--> statement-breakpoint
DO $users_email_normalized_guard$
DECLARE
  -- Postgres prints the trim set as one plain literal holding the raw characters;
  -- quote_literal spells it the same way (checked on PG 15 and 18).
  expected_definition constant text :=
    'CHECK ((email = lower(btrim(email, '
    || pg_catalog.quote_literal(U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
    || '::text))))';
  found_definition text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = '"users"'::regclass AND conname = 'users_email_normalized'
  ) THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_email_normalized" CHECK ("users"."email" = pg_catalog.lower(pg_catalog.btrim("users"."email", U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'))) NOT VALID;
    -- Only on the add path: production's runbook constraint already exists.
    IF NOT EXISTS (
      SELECT 1 FROM "users"
      WHERE "users"."email" <> pg_catalog.lower(pg_catalog.btrim("users"."email", U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'))
    ) THEN
      ALTER TABLE "users" VALIDATE CONSTRAINT "users_email_normalized";
    END IF;
  END IF;

  SELECT pg_catalog.pg_get_constraintdef(oid)
  INTO found_definition
  FROM pg_catalog.pg_constraint
  WHERE conrelid = '"users"'::regclass AND conname = 'users_email_normalized';

  -- A database with legacy rows keeps the check NOT VALID, and only that state
  -- carries the suffix, so both spellings are the expected check.
  IF found_definition IS DISTINCT FROM expected_definition
    AND found_definition IS DISTINCT FROM expected_definition || ' NOT VALID' THEN
    RAISE EXCEPTION 'users_email_normalized on users is not the stored-form email check'
      USING
        DETAIL = pg_catalog.format('Found %s.', found_definition),
        HINT = 'Drop the constraint, add it with the definition in this migration '
          || '(owner runbook #7430), then re-run the migration.';
  END IF;
END $users_email_normalized_guard$;--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
