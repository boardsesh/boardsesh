-- Custom SQL migration file, put your code below! --
--
-- Part of the climb-characteristics system (see @boardsesh/shared-schema
-- CLIMB_CHARACTERISTICS). The structural ADD COLUMN landed in 0134; this
-- migration adds the GIN index and the one-time backfill.
--
-- 1) GIN index on the characteristics array so containment filters
--    (`characteristics @> ARRAY['no_match']`) are index-backed — same approach as
--    compatible_size_ids' GIN index (migration 0073). Declared in raw SQL (not in
--    the drizzle schema) so drizzle-kit generate never emits a destructive diff
--    for it. IF NOT EXISTS keeps the migration idempotent.
CREATE INDEX IF NOT EXISTS "board_climbs_characteristics_idx"
  ON "board_climbs" USING gin ("characteristics");
--> statement-breakpoint

-- 2) Backfill: promote the Aurora "No match" description prefix into the
--    characteristics array. Aurora encodes the no-match rule as a description
--    that starts with "no match" (case-insensitive); the same predicate the old
--    dedup filters used (`LOWER(description) LIKE 'no match%'`, matching the
--    /^no match/i regex in isNoMatchClimb). The description prefix is left in
--    place — it stays the Aurora wire format; the characteristic is additive and
--    becomes the internal source of truth.
--
--    Idempotent: array_append is guarded by NOT (... @> ARRAY['no_match']) so a
--    re-run never duplicates the token. Ingest write paths (aurora-sync,
--    kilter-sync) also set the token going forward.
UPDATE board_climbs
   SET characteristics = array_append(COALESCE(characteristics, '{}'), 'no_match')
 WHERE LOWER(COALESCE(description, '')) LIKE 'no match%'
   AND NOT (COALESCE(characteristics, '{}') @> ARRAY['no_match']);
