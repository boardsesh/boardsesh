-- Custom SQL migration file, put your code below! --

-- Data-only repair for #3534: 8 MoonBoard rows (all angle=40) violate the
-- board_climb_stats invariant ascensionist_count = COALESCE(upstream,0) +
-- COALESCE(boardsesh,0). All 8 have boardsesh_ascensionist_count NULL and
-- upstream_synced_at NULL, meaning no live writer (the current
-- import-moonboard-catalog.ts importer, the two deprecated/local-only
-- importers guarded by assertMoonBoardImportAllowed since #3530, the tick
-- recompute in recompute.ts, or the moonboard-import backend service, which
-- never touches ascensionist_count at all) has ever stamped these rows under
-- today's invariant-preserving logic. They are stale legacy data left by a
-- writer that was retired and fixed in 454cfd4aa (see the history below), not
-- an active bug, so no code guard accompanies this migration.
--
-- Without this fix, the first Boardsesh tick recorded against any of these 8
-- keys triggers recomputeClimbStats/recomputeClimbStatsBulk, which always
-- writes ascensionist_count := COALESCE(upstream,0) + COALESCE(boardsesh,0)
-- in the same statement — silently collapsing the manufacturer-reported
-- total down to the stale upstream_ascensionist_count plus that one tick,
-- e.g. climb 321b5952.../40 would drop from 64 to 4 (stale upstream 3 + 1).
--
-- Repair direction: raise upstream_ascensionist_count and leave the total
-- alone. upstream is present on all 8 rows (one is 0, none are NULL) but
-- stale, and git history shows how it went stale:
--   * 2026-02-08 (2fe4d54e9): import-moonboard-problems.ts inserted these
--     problems with ascensionistCount := problem.repeats, the small Feb-era
--     values.
--   * 2026-05-15 (migration 0099, b1d8089da): the source-column split seeded
--     aurora_ascensionist_count := ascensionist_count, freezing upstream at
--     those Feb repeats (4, 3, 0, 2, 4, 2, 7, 2 — sum 24).
--   * 2026-06-26 (import-moonboard-catalog.ts at 377babf4b): its upsert did
--     ascensionist_count := greatest(coalesce(excluded,0), coalesce(existing,0))
--     with no write to upstream_ascensionist_count and no upstream_synced_at
--     stamp. It matched these rows on fingerprint and raised the total to the
--     June catalog community counts (26, 64, 3, 7, 17, 20, 24, 3 — sum 164),
--     leaving upstream behind. Importer fixed 2026-07-05 in 454cfd4aa.
--   * 2026-07-05 (migration 0141, same commit 454cfd4aa): its recover step
--     upstream := GREATEST(ascensionist_count - COALESCE(boardsesh,0), 0) is
--     gated on upstream_ascensionist_count IS NULL. These 8 carry a non-NULL
--     0099-seeded upstream, so 0141 skipped exactly them — its own header
--     names non-NULL-upstream rows as the set it leaves alone.
-- So the total is the June catalog number and upstream is a February
-- leftover. This migration runs 0141's recover formula over the rows 0141's
-- NULL guard missed.
--
-- Timing: if a first tick lands on one of these 8 keys before this migration
-- applies, that recompute collapses the row to stale upstream + 1, this
-- migration then correctly no-ops on it (the invariant holds again), and the
-- count this migration exists to save is already gone for that row. A reason
-- to land it promptly, not a defect in it.
--
-- Verified against read-only prod (DB_URL) immediately before writing this
-- migration. Before values (board_type/climb_uuid/angle: ascensionist_count,
-- upstream_ascensionist_count, boardsesh_ascensionist_count):
--   moonboard/061c5f64-746d-5365-8354-7274b0f6cd91/40: 26, 4,    NULL  -> upstream becomes 26
--   moonboard/321b5952-6516-55af-acf7-fe26f9ae9783/40: 64, 3,    NULL  -> upstream becomes 64
--   moonboard/906182bb-7eea-51a6-82ed-6b19882d422f/40: 3,  0,    NULL  -> upstream becomes 3
--   moonboard/b1c6f314-b52a-5608-bc96-90b1957cd719/40: 7,  2,    NULL  -> upstream becomes 7
--   moonboard/b33dfd8f-9955-5e5f-91c6-3edf365be8ce/40: 17, 4,    NULL  -> upstream becomes 17
--   moonboard/de81490c-5ab4-56b0-9eb1-ad86fe8e6807/40: 20, 2,    NULL  -> upstream becomes 20
--   moonboard/e8cf3f44-b3ef-5c62-9420-bdd52203ccd2/40: 24, 7,    NULL  -> upstream becomes 24
--   moonboard/fa71f7aa-9155-5620-8122-d545151a6036/40: 3,  2,    NULL  -> upstream becomes 3
-- (ascensionist_count itself is unchanged by this migration in every row;
-- only the upstream/boardsesh split is corrected.)
--
-- Idempotent: the WHERE clause re-checks the live invariant-violation
-- predicate in addition to the fixed PK list, so a second run (or a run
-- after a legitimate recompute has since corrected one of these rows)
-- touches 0 rows.
UPDATE board_climb_stats
SET upstream_ascensionist_count = ascensionist_count - COALESCE(boardsesh_ascensionist_count, 0)
WHERE (board_type, climb_uuid, angle) IN (
    ('moonboard', '061c5f64-746d-5365-8354-7274b0f6cd91', 40),
    ('moonboard', '321b5952-6516-55af-acf7-fe26f9ae9783', 40),
    ('moonboard', '906182bb-7eea-51a6-82ed-6b19882d422f', 40),
    ('moonboard', 'b1c6f314-b52a-5608-bc96-90b1957cd719', 40),
    ('moonboard', 'b33dfd8f-9955-5e5f-91c6-3edf365be8ce', 40),
    ('moonboard', 'de81490c-5ab4-56b0-9eb1-ad86fe8e6807', 40),
    ('moonboard', 'e8cf3f44-b3ef-5c62-9420-bdd52203ccd2', 40),
    ('moonboard', 'fa71f7aa-9155-5620-8122-d545151a6036', 40)
  )
  AND ascensionist_count IS DISTINCT FROM (
    COALESCE(upstream_ascensionist_count, 0) + COALESCE(boardsesh_ascensionist_count, 0)
  );
