-- Custom SQL migration file, put your code below! --
--
-- One-time backfill: stamp boardsesh_ticks.origin from the surrogate-key
-- provenance columns the sync/import writers already left behind. Migration
-- 0155 added `origin` with DEFAULT 'native', so every existing row is 'native'
-- until this pass corrects the imported ones. Going forward each writer stamps
-- origin at insert time, so this migration only ever runs once.
--
-- Buckets are mutually exclusive by construction (see the WHERE guards). Order
-- is irrelevant; each UPDATE only touches rows still on the 'native' default,
-- which also makes the whole migration idempotent (re-running is a no-op).
--
-- Prod snapshot the predicates were pinned against (2026-07, 366,310 ticks):
--   json_import : 281,572   (aurora_id LIKE 'json-import-%')
--   aurora_pull :  52,570   (real Aurora uuid + aurora_synced_at set)
--   kilter_pull :   3,734   (kilter-only, historical-climb gap; see below)
--   native      :  28,436   (everything else)

-- 1. JSON import: the importer mints a synthetic aurora_id `json-import-<hash>`
--    (packages/aurora-sync/src/sync/json-import.ts generateJsonImportAuroraId).
--    These ticks are already inside upstream_ascensionist_count.
UPDATE boardsesh_ticks
   SET origin = 'json_import'
 WHERE origin = 'native'
   AND aurora_id LIKE 'json-import-%';
--> statement-breakpoint

-- 2. Aurora pull: a real Aurora ascent/bid uuid (NOT the json-import synthetic)
--    written with aurora_synced_at stamped. The user-sync ascents/bids path
--    (packages/aurora-sync/src/sync/user-sync.ts) always sets aurora_synced_at
--    on insert. The aurora_synced_at predicate deliberately excludes the
--    dormant web saveAscent push path, which plants an aurora_id WITH
--    aurora_synced_at NULL — verified 0 such rows in prod, but the guard keeps
--    a future push job's rows out of the upstream bucket until they're pulled.
UPDATE boardsesh_ticks
   SET origin = 'aurora_pull'
 WHERE origin = 'native'
   AND aurora_id IS NOT NULL
   AND aurora_id NOT LIKE 'json-import-%'
   AND aurora_synced_at IS NOT NULL;
--> statement-breakpoint

-- 3. Kilter pull: rows INSERTED by the Kilter PowerSync logs path
--    (packages/kilter-sync/src/sync/user-sync.ts applyLogs inserts, ~L781-796).
--    That insert sets kilter_id = the Kilter log_uuid, leaves aurora_id NULL,
--    and lets created_at default to the sync run time — while climbed_at is the
--    real (historical) climb date the Kilter log carried. So a pulled row has a
--    large created_at - climbed_at gap.
--
--    We must NOT catch the natural-key ADOPTION path or push-back: both stamp
--    kilter_id onto a PRE-EXISTING native Boardsesh tick WITHOUT touching
--    created_at. A native tick is normally logged at climb time (created_at ≈
--    climbed_at), so its gap is tiny — the `> interval '1 hour'` threshold
--    separates the two cleanly. Pushed/adopted native ticks keep origin='native'
--    and keep counting, which is a locked product requirement.
--
--    Prod pinning (kilter_id set, aurora_id NULL — 3,734 rows): the SMALLEST
--    created_at - climbed_at gap is 4.54 hours; every row is > 1 hour; 0 rows
--    have created_at within 1 hour of climbed_at. So this predicate classifies
--    all 3,734 as kilter_pull with zero misclassification on the current data.
--    Residual risk (documented): a native tick BACK-logged more than an hour
--    after the climb that later gets pushed to Kilter would be misread as a pull
--    and lose its Boardsesh count contribution. Prod has 0 such rows today
--    (0/3,734 kilter-marked rows fall inside the 1-hour window), and every
--    future native push is stamped origin='native' at write time, so this
--    heuristic never applies to them — it is a one-shot classifier for the
--    pre-existing snapshot only.
--    Remediation if a misclassified row ever surfaces: `origin` is a plain
--    mutable column that nothing else stores, so reclassify with
--      UPDATE boardsesh_ticks SET origin = 'native' WHERE uuid IN (…);
--    and re-run recomputeClimbStatsBulk for the affected (board, climb, angle)
--    keys — the count self-heals from ticks.
UPDATE boardsesh_ticks
   SET origin = 'kilter_pull'
 WHERE origin = 'native'
   AND kilter_id IS NOT NULL
   AND aurora_id IS NULL
   AND created_at - climbed_at > interval '1 hour';

-- Everything else stays 'native' (the 0155 default): pure Boardsesh saveTick
-- rows, and native rows that later adopted/pushed a kilter_id (small gap).
