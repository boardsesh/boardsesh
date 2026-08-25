-- Custom SQL migration file, put your code below! --
--
-- One-time merge: collapse the duplicate Kilter playlists the pre-#4707 sync
-- created. Kilter used to be an ordinary Aurora board, so a pre-split circuit
-- already lived in `playlists` keyed on `aurora_id` with `kilter_id` still NULL.
-- `playlists_kilter_id_idx` is a GLOBAL, NON-PARTIAL unique and Postgres treats
-- NULLs there as distinct, so applyCircuits' `ON CONFLICT (kilter_id) DO UPDATE`
-- could never match that row: re-linking Kilter inserted a SECOND playlist for
-- every legacy circuit, carrying Kilter's stale pre-edit content and stamped
-- `created_at = now()`.
--
-- The code fix (adoption step in applyCircuits) stops NEW duplicates. This
-- merges the ones already in the table.
--
-- Direction: KEEP the legacy row. It owns the `uuid` that user_playlist_pins,
-- playlist_follows and every offline client already point at. Its Kilter
-- surrogate keys are moved off the twin, then the twin is deleted;
-- playlist_climbs + playlist_ownership cascade off playlist_id, and the
-- trg_playlists_delete trigger emits a sync_deletions row keyed on the twin's
-- uuid so mobile clients drop it cleanly.
--
-- `kilter_synced_at` on the surviving row is set to
-- COALESCE(aurora_synced_at, created_at), NOT now() — exactly what the code
-- path stamps on adoption. The column means "Kilter's content was last written
-- into this row"; claiming a content sync that never happened would make the
-- edit-clobber guard read "no local edits" and let Kilter's stale snapshot
-- overwrite the user's Boardsesh-side edits on the next cycle. The surviving
-- row's own content (name/description/is_public/color/playlist_climbs) is left
-- exactly as the user left it.
--
-- Conservative: only an UNAMBIGUOUS 1:1 pair inside a SINGLE sole owner is
-- merged — a legacy row with >1 candidate twin, or a twin claimed by >1 legacy
-- row, is left completely untouched and counted in the RAISE NOTICE. Matching
-- is `aurora_id = kilter_id` OR an exactly-equal normalized name, the same two
-- tiers the code uses. Rows with more than one `owner` edge (the cross-linked
-- accounts from #3541) are excluded entirely.
--
-- ⚠️ IN PRACTICE THIS MIGRATION IS ENTIRELY NAME-BASED. An earlier draft of this
-- header said `aurora_id = kilter_id` matches because "Grips kept the circuit
-- uuid". Measured against production, that tier is INERT and always will be:
-- legacy `aurora_id` is either a synthetic `json-import-…` value (3,036 of
-- 3,162) or a 32-char undashed Aurora uuid, while every `kilter_id` is a 36-char
-- dashed Kilter uuid. Overlap is 0, and still 0 after normalising case/dashes.
-- Read every risk statement below as applying to name equality, not identity.
--
-- Measured on production 2026-08-25 13:44 UTC (read-only, primary — the same
-- CTEs below, run verbatim as SELECTs). 0165 bakes its counts in; so does this:
--
--   clean 1:1 pairs merged .............  95   (of 103 candidate pairs)
--   playlists rows DELETEd .............  95
--   users affected .....................  12
--   tier 1 (aurora_id = kilter_id) .....   0   ← inert, see above
--   tier 2 (normalized name) ...........  95   (100%)
--   ambiguous, left untouched ..........   4 legacy rows / 8 twins
--   twins with USER edits ..............   0   (on all 95, updated_at is
--                                              EXACTLY kilter_synced_at: every
--                                              twin's last write was the sync)
--   user_playlist_pins destroyed .......   0
--   playlist_follows destroyed .........   0
--
-- What name-matching costs, also measured: 92 of 95 pairs share climbs and 69
-- twins are strict subsets of the surviving row, but 71 playlist_climbs rows
-- across 26 pairs exist ONLY on the twin and are lost with it. Exactly 2 pairs
-- have fully disjoint climb sets, and both are generic names ('projects', 'to
-- try') — the shape most likely to be a false pair. Those 71 rows are the known
-- cost of name-matching, and they do not come back: the surviving row's
-- `updated_at` stays ahead of the `kilter_synced_at` this migration stamps, so
-- the edit-clobber guard in applyCircuits reads it as locally edited and
-- Kilter's copy of those climbs never re-lands.
--
-- For scale: 3,162 legacy rows across 354 owners are still un-duplicated. That
-- is the population #4746's adoption step stops from ever duplicating.
--
-- This migration is NOT value-idempotent. Safety comes from BOTH the migrator's
-- single transaction + __drizzle_migrations bookkeeping AND a durable
-- _bs_migration_guards row, so even a manual psql re-application is a no-op.
--
-- ⚠️ NEVER run this file manually via psql: outside the migrator's transaction
-- there is nothing but the guard row below to stop a re-application.

CREATE TABLE IF NOT EXISTS _bs_migration_guards (
  tag text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE
  v_clean bigint;
  v_ambiguous_legacy bigint;
  v_ambiguous_twin bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM _bs_migration_guards WHERE tag = '0205_kilter_playlist_dedup_backfill') THEN
    RAISE NOTICE 'kilter playlist dedup already applied — skipping (guard row present)';
    RETURN;
  END IF;

  -- (1) Every candidate legacy↔twin pair. Both sides must be kilter-board and
  -- have exactly ONE `owner` edge, and it must be the SAME user: a playlist
  -- with two owners is the #3541 cross-link shape, which no automated merge may
  -- touch.
  CREATE TEMP TABLE _kp_pairs ON COMMIT DROP AS
  WITH sole_owner AS (
    SELECT po.playlist_id, MIN(po.user_id) AS user_id
      FROM playlist_ownership po
     WHERE po.role = 'owner'
     GROUP BY po.playlist_id
    HAVING COUNT(DISTINCT po.user_id) = 1
  ),
  legacy AS (
    SELECT p.id, p.aurora_id, lower(btrim(p.name)) AS norm_name, so.user_id
      FROM playlists p
      JOIN sole_owner so ON so.playlist_id = p.id
     WHERE p.board_type = 'kilter'
       AND p.kilter_id IS NULL
       AND p.aurora_id IS NOT NULL
  ),
  twin AS (
    SELECT p.id, p.kilter_id, p.kilter_type, p.kilter_synced_at,
           lower(btrim(p.name)) AS norm_name, so.user_id
      FROM playlists p
      JOIN sole_owner so ON so.playlist_id = p.id
     WHERE p.board_type = 'kilter'
       AND p.kilter_id IS NOT NULL
       -- A twin the buggy sync created NEVER carries `aurora_id`: the insert in
       -- `applyCircuits` writes uuid/name/kilter_* and no aurora column at all.
       -- A row with BOTH set is therefore not a twin — it is a legacy row that
       -- #4746's adoption already merged in place, i.e. exactly the row this
       -- migration exists to protect. Without this predicate an adopted row is
       -- eligible as a `twin`, and a leftover same-named JSON-import copy can
       -- pair with it as a "clean" 1:1 and delete the user's real, pinned
       -- playlist. Pre-#4746 that shape was degree-2 ambiguous and thus safe;
       -- adoption removes the ambiguity signal, and it has been running in
       -- production since #4746 merged, so the population grows every cycle.
       -- 0165 draws the same line with its `origin = 'kilter_pull'` filter.
       AND p.aurora_id IS NULL
  )
  SELECT l.id AS legacy_id,
         t.id AS twin_id,
         t.kilter_id,
         t.kilter_type
    FROM legacy l
    JOIN twin t
      ON t.user_id = l.user_id
     AND t.id <> l.id
     AND (l.aurora_id = t.kilter_id OR l.norm_name = t.norm_name);

  -- (2) Keep only unambiguous 1:1 components.
  CREATE TEMP TABLE _kp_clean ON COMMIT DROP AS
  WITH legacy_deg AS (SELECT legacy_id, COUNT(*) AS c FROM _kp_pairs GROUP BY legacy_id),
       twin_deg   AS (SELECT twin_id,   COUNT(*) AS c FROM _kp_pairs GROUP BY twin_id)
  SELECT p.*
    FROM _kp_pairs p
    JOIN legacy_deg ld ON ld.legacy_id = p.legacy_id AND ld.c = 1
    JOIN twin_deg   td ON td.twin_id   = p.twin_id   AND td.c = 1;

  SELECT COUNT(*) INTO v_clean FROM _kp_clean;
  SELECT COUNT(DISTINCT legacy_id) INTO v_ambiguous_legacy
    FROM _kp_pairs WHERE legacy_id NOT IN (SELECT legacy_id FROM _kp_clean);
  SELECT COUNT(DISTINCT twin_id) INTO v_ambiguous_twin
    FROM _kp_pairs WHERE twin_id NOT IN (SELECT twin_id FROM _kp_clean);

  -- (3a) Clear the surrogate on the twins first so moving it onto the legacy
  -- row cannot transiently collide on playlists_kilter_id_idx.
  UPDATE playlists p
     SET kilter_id = NULL, kilter_type = NULL, kilter_synced_at = NULL
    FROM _kp_clean c
   WHERE p.id = c.twin_id;

  -- (3b) Stamp the Kilter surrogate onto the surviving legacy row. Content,
  -- climbs and updated_at are deliberately untouched — the user's Boardsesh
  -- edits are the only copy that exists while circuit push-back is stubbed
  -- (#3525), and leaving updated_at alone is what keeps the edit-clobber guard
  -- in applyCircuits reading them as local edits.
  UPDATE playlists p
     SET kilter_id        = c.kilter_id,
         kilter_type      = c.kilter_type,
         kilter_synced_at = COALESCE(p.aurora_synced_at, p.created_at)
    FROM _kp_clean c
   WHERE p.id = c.legacy_id;

  -- (3c) Delete the now-unlinked twins. playlist_climbs + playlist_ownership
  -- cascade; trg_playlists_delete tombstones the uuid for offline clients.
  DELETE FROM playlists p USING _kp_clean c WHERE p.id = c.twin_id;

  INSERT INTO _bs_migration_guards (tag) VALUES ('0205_kilter_playlist_dedup_backfill');

  RAISE NOTICE 'kilter playlist dedup: merged % clean 1:1 pair(s); left % ambiguous legacy row(s) and % ambiguous twin(s) untouched',
    v_clean, v_ambiguous_legacy, v_ambiguous_twin;
END $$;
