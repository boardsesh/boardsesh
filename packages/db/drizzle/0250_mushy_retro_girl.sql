-- board_climb_aliases has live catalog writers. Do not make the first
-- production build hold the write-conflicting SHARE lock for its full scan.
-- The production operator must prebuild this exact index with CREATE INDEX
-- CONCURRENTLY and verify its definition plus indisvalid/indisready before the
-- first deploy that can apply this migration. Production deploy runs migrations
-- automatically; the prebuild remains a release prerequisite, not a claim that
-- this migration has already run in production. See docs/db-migrations.md.
--
-- Drizzle wraps migrations in a transaction, so CONCURRENTLY cannot run here.
-- IF NOT EXISTS makes a verified prebuilt production index a no-op while fresh
-- dev/test/CI databases still build the same index.
CREATE INDEX IF NOT EXISTS "board_climb_aliases_alias_uuid_idx"
  ON "board_climb_aliases" USING btree ("alias_uuid");
