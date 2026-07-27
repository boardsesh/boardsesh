-- Custom SQL migration file, put your code below! --
--
-- One-time dedup: collapse MoonBoard's per-angle climb duplication so climb
-- identity becomes angle-agnostic, matching Kilter/Tension. Today's importer
-- (packages/db/scripts/import-moonboard-catalog.ts) mints climb UUID
-- `moonboard:{problemId}:{angle}`, so one physical MoonBoard problem produces
-- TWO board_climbs rows (one per graded angle, typically 25° and 40°) with
-- duplicated board_climb_holds. This migration merges each such pair (or
-- larger group, if a future re-import ever grades more angles) onto a single
-- canonical row via board_climb_aliases, the same mechanism 0163 used for
-- same-angle catalog dupes.
--
-- THIS IS THE OPPOSITE MERGE POLICY FROM 0163_merge_moonboard_duplicates.sql
-- ON PURPOSE. 0163 deliberately grouped by (layout_id, hold_fingerprint,
-- ANGLE) and its header states "the same holds at 25 vs 40 degrees are
-- different problems on the wall, so grouping without angle would wrongly
-- merge them" — that was correct under the OLD per-angle-identity model. The
-- product model has since changed: a MoonBoard problem is now one climb
-- (like Kilter/Tension), and angle is purely a stats dimension
-- (board_climb_stats already keys on (board_type, climb_uuid, angle) and
-- ALREADY stores MoonBoard's per-angle grade/quality/ascent data there, not
-- on board_climbs — see import-moonboard-catalog.ts's stats upsert). So this
-- migration groups WITHOUT angle and, critically, NEVER combines two
-- members' stats into one row the way 0163 does for a true same-angle
-- dupe — every member's board_climb_stats row survives, re-keyed onto the
-- canonical uuid at its OWN original angle. A problem graded at 25° and 40°
-- still shows both grades post-merge; it just does so as one climb with two
-- stats rows instead of two climbs with one stats row each.
--
-- Two rows are grouped when they share (layout_id, live hold signature).
-- board_climbs.hold_fingerprint is sparse (import-moonboard-catalog.ts:
-- "existing MoonBoard climbs predate the fingerprint column... only layout 3
-- has it populated in prod"), so the signature is computed live from
-- board_climb_holds instead of trusted from that column. This also means
-- this migration's grouping is a strict superset of 0163's: it can catch
-- residual same-angle duplicates on layouts 0163's fingerprint-gated query
-- never reached. A group is only auto-merged when every member sits at a
-- DISTINCT angle (the expected one-problem-N-graded-angles shape); a group
-- with two members at the SAME angle needs 0163's SUM/MAX same-angle
-- ascent-merge policy, not this migration's angle-preserving one, so it is
-- left completely untouched and counted in the RAISE NOTICE for manual
-- follow-up.
--
-- Per group: pick a canonical (most own-angle ascents, tie-break oldest
-- created_at, then uuid — same policy as 0163), alias every other member
-- onto it (source='moonboard-angle-dedup'), re-key every member's own
-- board_climb_stats rows onto the canonical (preserving each row's angle),
-- repoint every table that references a climb UUID, and DELIST (never
-- DELETE) the non-canonical board_climbs rows — deleting them would
-- CASCADE-drop their board_climb_holds/board_climb_aliases rows, none of
-- which need removing since nothing downstream reads a delisted row
-- directly. Fenced to catalog rows (user_id IS NULL) throughout, exactly
-- like 0163: a user-created single-angle MoonBoard climb is never grouped,
-- aliased, delisted, or repointed by this migration.
--
-- MULTI-MEMBER COLLISIONS (groups of 3+): every dedupe-then-repoint step
-- below ranks ALL rows touching a group — the canonical's own pre-existing
-- row (if any) plus every alias member's row — for each post-repoint unique
-- key, and keeps exactly one. This matters because a >2-member group can
-- have two DIFFERENT non-canonical members both holding a row that would
-- collide once repointed (e.g. two users each added a different losing
-- angle-row to the same playlist) — checking only "does the row collide with
-- the CANONICAL's own row" (as an earlier version of this migration did)
-- misses alias-vs-alias collisions entirely and aborts the whole migration
-- with a unique-constraint violation on deploy.
--
-- Explicitly NOT touched (left pointing at their original uuid):
--   * sync_deletions — an append-only log of deletions that already
--     happened; its encoded climb_uuid is a historical fact, not a live
--     reference, so it stays as originally recorded.
--   * app_feedback.context.climbUuid — informational JSONB, not a real
--     relational reference.
-- board_climb_ratings IS defensively repointed below (step 5b) even though
-- it structurally CANNOT contain a moonboard row today: its only writer in
-- the whole codebase (packages/kilter-sync/src/sync/user-sync.ts) hardcodes
-- boardType to KILTER_BOARD_TYPE (verified by reading every insert into this
-- table, not inferred from a prod count — no prod DB access at authoring
-- time). The repoint is a no-op today and costs nothing; it's there so this
-- migration stays correct if that ever changes.
-- (board_climb_stats_history IS repointed below, unlike 0163/0165/0166's
-- ticks-merge migrations — this one never deletes a climb row, so repointing
-- the audit trail is safe and keeps it queryable from the canonical uuid.)
--
-- vote_counts.hot_score has no scheduled recompute job (verified: no cron/
-- workflow touches it), so it is rebuilt here from scratch for every
-- affected canonical, matching update_vote_counts() EXACTLY — the live
-- trigger on `votes` (created in 0053_add_vote_counts.sql, re-created
-- identically in 0130_vote_count_skip_guard.sql) and the same recipe
-- rebuildGymVoteCounts() in packages/db/src/queries/gyms/merge-gyms.ts uses
-- for gym merges:
--   hot_score = SIGN(score) * LN(GREATEST(ABS(score), 1))
--             + EXTRACT(EPOCH FROM created_at) / 45000.0
--   created_at = COALESCE(feed_items.created_at, MIN(votes.created_at), NOW())
-- Plain Unix epoch — no Reddit-epoch offset (an earlier version of this
-- migration subtracted TIMESTAMP '2005-12-08', which doesn't appear anywhere
-- in the trigger and would have sunk every merged climb ~25,200 points in
-- hot ordering relative to every trigger-computed row). The bulk votes
-- DELETE/UPDATE below runs with boardsesh.skip_vote_counts='on' (same guard
-- the gym-merge path uses) so the per-row trigger doesn't do wasted/premature
-- recomputes mid-repoint; vote_counts is then rebuilt in one pass afterwards.
--
-- Recommendation/ML caches (board_climb_embeddings, board_climb_similar) are
-- fully rebuilt from board_climbs/board_climb_stats on their own schedule
-- (load-similarity.ts does a full per-board DELETE+reinsert; the weekly
-- refresh-content-model.yml re-scores every climb), so merged-away rows are
-- simply dropped rather than merged. board_climb_grades explicitly excludes
-- MoonBoard (refresh-climb-grades.ts) — nothing to do there.
--
-- NOT idempotent by itself (a second application would attempt to re-group
-- already-delisted rows, which the user_id/is_listed fences mostly but not
-- fully neutralize), so a durable _bs_migration_guards row makes even a
-- manual re-application a no-op, same as every migration in this family.
--
-- ⚠️ NEVER run this file manually via psql: outside the migrator's
-- transaction there is nothing but the guard row below to stop a
-- re-application.
--
-- ⚠️ DEPLOY ORDERING: do not run packages/db/scripts/import-moonboard-catalog.ts
-- between this migration landing and the angle-agnostic importer rewrite
-- (#3851) landing. The pre-#3851 importer still matches incoming problems on
-- (layout_id, angle, hold_fingerprint) and skips delisted rows — so an
-- incoming problem at a now-delisted angle finds no match, re-mints
-- moonboard:{id}:{angle}, and its alias upsert (catalogAliasConflictUpdate())
-- overwrites this migration's alias back to self-pointing, re-splitting that
-- problem's ticks/logbook resolution and re-creating a stats row under the
-- delisted uuid. Safe order: this migration -> #3851's importer -> (only
-- then) any catalog import.
--
-- Prod group/member counts are NOT pre-verified for this migration (no live
-- prod DB access at authoring time, and the standard dev-db seed uses an
-- older single-row-per-problem importer that doesn't reproduce this
-- duplication — see import-moonboard-problems.ts). Every step below is
-- written to be correct for any group size/count, but run a read-only sizing
-- query against prod (see the _mad_groups/_mad_raw_groups shape below) before
-- deploying, and update this comment with the numbers per repo convention.

CREATE TABLE IF NOT EXISTS _bs_migration_guards (
  tag text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

DO $$
DECLARE
  v_groups bigint;
  v_skipped_ambiguous bigint;
  v_merged bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM _bs_migration_guards WHERE tag = '0188_moonboard_angle_dedup_backfill') THEN
    RAISE NOTICE '0188 moonboard angle dedup already applied — skipping (guard row present)';
    RETURN;
  END IF;

  -- Live per-climb hold signature (board_climbs.hold_fingerprint is sparse —
  -- see header — so compute it directly from board_climb_holds). Deliberately
  -- omits frame_number: MoonBoard climbs are always single-frame
  -- (frames_count = 1, no multi-move routes), so it never distinguishes two
  -- otherwise-identical hold sets here — safe to drop from the signature.
  CREATE TEMP TABLE _mad_fingerprints ON COMMIT DROP AS
    SELECT climb_uuid,
           string_agg(hold_id::text || ':' || hold_state, ',' ORDER BY hold_id) AS fp
      FROM board_climb_holds
     WHERE board_type = 'moonboard'
     GROUP BY climb_uuid;

  -- Catalog-only members (user_id IS NULL fences out Boardsesh-native
  -- single-angle user climbs, matching 0163's identical fence) with a
  -- resolved fingerprint and a real angle.
  CREATE TEMP TABLE _mad_members ON COMMIT DROP AS
    SELECT bc.uuid, bc.angle, bc.layout_id, bc.created_at, f.fp,
           COALESCE(s.upstream_ascensionist_count, 0) AS ascents
      FROM board_climbs bc
      JOIN _mad_fingerprints f ON f.climb_uuid = bc.uuid
      LEFT JOIN board_climb_stats s
        ON s.board_type = 'moonboard' AND s.climb_uuid = bc.uuid AND s.angle = bc.angle
     WHERE bc.board_type = 'moonboard'
       AND bc.user_id IS NULL
       AND bc.is_draft = false
       AND bc.is_listed IS NOT FALSE
       AND bc.angle IS NOT NULL;

  -- Raw groups: >1 member sharing (layout, fingerprint), regardless of angle.
  CREATE TEMP TABLE _mad_raw_groups ON COMMIT DROP AS
    SELECT layout_id, fp, count(*) AS member_count, count(DISTINCT angle) AS distinct_angles
      FROM _mad_members
     GROUP BY layout_id, fp
    HAVING count(*) > 1;

  -- Only auto-merge groups where every member sits at a distinct angle (see
  -- header for why a same-angle collision is left untouched here).
  CREATE TEMP TABLE _mad_groups ON COMMIT DROP AS
    SELECT layout_id, fp FROM _mad_raw_groups WHERE member_count = distinct_angles;

  SELECT count(*) INTO v_groups FROM _mad_groups;
  SELECT count(*) INTO v_skipped_ambiguous FROM _mad_raw_groups WHERE member_count <> distinct_angles;

  -- Canonical per group: most own-angle ascents, tie-break oldest
  -- created_at, then uuid — same policy as 0163.
  CREATE TEMP TABLE _mad_canon ON COMMIT DROP AS
    SELECT DISTINCT ON (m.layout_id, m.fp) m.layout_id, m.fp, m.uuid AS canonical_uuid
      FROM _mad_members m
      JOIN _mad_groups g ON g.layout_id = m.layout_id AND g.fp = m.fp
     ORDER BY m.layout_id, m.fp, m.ascents DESC, m.created_at ASC NULLS LAST, m.uuid ASC;

  -- Non-canonical member -> canonical uuid, carrying its own angle (needed by
  -- every angle-preserving repoint step below).
  CREATE TEMP TABLE _mad_map ON COMMIT DROP AS
    SELECT m.uuid AS alias_uuid, m.angle, c.canonical_uuid
      FROM _mad_members m
      JOIN _mad_canon c ON c.layout_id = m.layout_id AND c.fp = m.fp
     WHERE m.uuid <> c.canonical_uuid;

  SELECT count(*) INTO v_merged FROM _mad_map;

  -- All (canonical_uuid, member_uuid) pairs including the self-pair — used
  -- below to find every vote_counts row (canonical's own + every alias's)
  -- feeding the hot_score recompute.
  CREATE TEMP TABLE _mad_all_ids ON COMMIT DROP AS
    SELECT canonical_uuid, alias_uuid AS uuid FROM _mad_map
    UNION
    SELECT DISTINCT canonical_uuid, canonical_uuid FROM _mad_map;

  -- 1. Alias every non-canonical row onto the canonical. Repoint any
  --    pre-existing alias that (unexpectedly) already pointed at an
  --    alias_uuid first, defensively, then upsert the direct alias.
  --    This UPDATE fixes EVERY row whose canonical_uuid currently equals ANY
  --    alias_uuid being retired in this batch (_mad_map), regardless of how
  --    many logical hops that row represents in some pre-existing chain — so
  --    this migration never WORSENS chain depth for anything it touches.
  --    KNOWN LIMITATION (pre-existing, not introduced here, same as 0163):
  --    packages/db/src/queries/aliases.ts's resolveCanonicalClimbUuid (the
  --    general app-wide resolver used by ticks/climb lookups) does a SINGLE
  --    lookup, not a full chain walk. If some OTHER, unrelated process ever
  --    created a chain deeper than one hop (Y -> X -> Z, where X is not
  --    itself retired by this migration), that resolver already returned the
  --    intermediate node X for Y before this migration ran, and still will
  --    after — orthogonal to what 0185 does. No evidence this shape exists in
  --    prod; flattening it would be a separate, general alias-integrity fix.
  UPDATE board_climb_aliases a
     SET canonical_uuid = m.canonical_uuid, last_seen_at = now()
    FROM _mad_map m
   WHERE a.board_type = 'moonboard' AND a.canonical_uuid = m.alias_uuid;

  INSERT INTO board_climb_aliases (board_type, alias_uuid, canonical_uuid, source)
  SELECT 'moonboard', alias_uuid, canonical_uuid, 'moonboard-angle-dedup' FROM _mad_map
  ON CONFLICT (board_type, alias_uuid) DO UPDATE
    SET canonical_uuid = excluded.canonical_uuid, last_seen_at = now();

  -- 2. Re-key ALL of each alias's board_climb_stats rows onto the canonical
  --    uuid, preserving each row's own angle — NOT just the row at the
  --    member's "native" board_climbs.angle. A stats row can also exist at a
  --    non-native angle (e.g. minted by the tick recompute when someone
  --    logged a tick at a different angle than the climb's own), and step 3
  --    below repoints that tick unconditionally — so its stats row must
  --    follow, or it's orphaned under the delisted uuid (double-counted by
  --    anything scanning board_climb_stats broadly) and never reaches the
  --    canonical. ON CONFLICT already merges conservatively (COALESCE/
  --    GREATEST) for the case where the canonical independently has its own
  --    row at that same angle.
  INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, benchmark_difficulty,
         ascensionist_count, upstream_ascensionist_count, boardsesh_ascensionist_count, difficulty_average,
         quality_average, upstream_quality_average, quality_normalized, fa_username, fa_at, upstream_synced_at)
  SELECT s.board_type, m.canonical_uuid, s.angle, s.display_difficulty, s.benchmark_difficulty,
         s.ascensionist_count, s.upstream_ascensionist_count, s.boardsesh_ascensionist_count, s.difficulty_average,
         s.quality_average, s.upstream_quality_average, s.quality_normalized, s.fa_username, s.fa_at, s.upstream_synced_at
    FROM board_climb_stats s
    JOIN _mad_map m ON m.alias_uuid = s.climb_uuid
   WHERE s.board_type = 'moonboard'
  ON CONFLICT (board_type, climb_uuid, angle) DO UPDATE SET
    display_difficulty = COALESCE(board_climb_stats.display_difficulty, excluded.display_difficulty),
    benchmark_difficulty = COALESCE(board_climb_stats.benchmark_difficulty, excluded.benchmark_difficulty),
    ascensionist_count = GREATEST(COALESCE(board_climb_stats.ascensionist_count, 0), COALESCE(excluded.ascensionist_count, 0)),
    upstream_ascensionist_count = GREATEST(COALESCE(board_climb_stats.upstream_ascensionist_count, 0), COALESCE(excluded.upstream_ascensionist_count, 0)),
    boardsesh_ascensionist_count = GREATEST(COALESCE(board_climb_stats.boardsesh_ascensionist_count, 0), COALESCE(excluded.boardsesh_ascensionist_count, 0)),
    difficulty_average = COALESCE(board_climb_stats.difficulty_average, excluded.difficulty_average),
    quality_average = COALESCE(board_climb_stats.quality_average, excluded.quality_average),
    upstream_quality_average = COALESCE(board_climb_stats.upstream_quality_average, excluded.upstream_quality_average),
    fa_username = COALESCE(board_climb_stats.fa_username, excluded.fa_username),
    fa_at = COALESCE(board_climb_stats.fa_at, excluded.fa_at),
    quality_normalized = board_climb_stats.quality_normalized OR excluded.quality_normalized,
    upstream_synced_at = GREATEST(board_climb_stats.upstream_synced_at, excluded.upstream_synced_at);

  -- The rows just copied onto the canonical uuid now fully duplicate the
  -- retiring uuid's own stats rows (same board_type/angle, identical values) —
  -- drop the originals so nothing that scans board_climb_stats broadly (a
  -- leaderboard, a bulk recompute) double-counts a delisted climb's ascents.
  -- Safe: every value has already been copied forward by the INSERT above.
  DELETE FROM board_climb_stats s USING _mad_map m
   WHERE s.board_type = 'moonboard' AND s.climb_uuid = m.alias_uuid;

  -- 3. Plain repoints — climb_uuid moves to canonical, each row's own
  --    angle/value is untouched, no uniqueness collision is possible.
  UPDATE boardsesh_ticks t SET climb_uuid = m.canonical_uuid
    FROM _mad_map m WHERE t.board_type = 'moonboard' AND t.climb_uuid = m.alias_uuid;

  UPDATE board_climb_stats_history h SET climb_uuid = m.canonical_uuid
    FROM _mad_map m WHERE h.board_type = 'moonboard' AND h.climb_uuid = m.alias_uuid;

  UPDATE board_climb_events e SET climb_uuid = m.canonical_uuid
    FROM _mad_map m WHERE e.board_type = 'moonboard' AND e.climb_uuid = m.alias_uuid;

  UPDATE climb_proposals p SET climb_uuid = m.canonical_uuid
    FROM _mad_map m WHERE p.board_type = 'moonboard' AND p.climb_uuid = m.alias_uuid;

  UPDATE comments c SET entity_id = m.canonical_uuid
    FROM _mad_map m WHERE c.entity_type = 'climb' AND c.entity_id = m.alias_uuid;

  UPDATE feed_items f SET entity_id = m.canonical_uuid
    FROM _mad_map m WHERE f.entity_type = 'climb' AND f.entity_id = m.alias_uuid;

  UPDATE notifications n SET entity_id = m.canonical_uuid
    FROM _mad_map m WHERE n.entity_type = 'climb' AND n.entity_id = m.alias_uuid;

  -- 4. Repoints where the uniqueness constraint does NOT include angle, so a
  --    real collision is possible. Ranks EVERY row touching the group — the
  --    canonical's own pre-existing row (if any) plus every alias member's
  --    row — per post-repoint key, keeping exactly one: the canonical's own
  --    row always wins if present, otherwise the lowest-id/ctid alias row
  --    wins (arbitrary but deterministic). This is NOT just "does it collide
  --    with the canonical" — two DIFFERENT non-canonical members can collide
  --    with EACH OTHER once both repoint onto the same canonical, which a
  --    canonical-only check misses entirely (reproduced against a scratch DB
  --    with a 3-member group: two losing members both playlisted, migration
  --    aborted with a unique-constraint violation).
  WITH ranked AS (
    SELECT pc.id,
           EXISTS (
             SELECT 1 FROM playlist_climbs pc3
              WHERE pc3.playlist_id = pc.playlist_id AND pc3.climb_uuid = m.canonical_uuid
           ) AS canonical_has_own,
           ROW_NUMBER() OVER (PARTITION BY pc.playlist_id, m.canonical_uuid ORDER BY pc.id) AS rn
      FROM playlist_climbs pc
      JOIN _mad_map m ON m.alias_uuid = pc.climb_uuid
  )
  DELETE FROM playlist_climbs pc USING ranked r
   WHERE pc.id = r.id AND (r.canonical_has_own OR r.rn > 1);
  UPDATE playlist_climbs pc SET climb_uuid = m.canonical_uuid
    FROM _mad_map m WHERE pc.climb_uuid = m.alias_uuid;

  -- A collision here can leave a gap in the circuit's position sequence
  -- (the dropped row's slot isn't resequenced) — accepted: position only
  -- drives ORDER BY for circuit member display, which doesn't need contiguity.
  -- No surrogate id on this table; ctid is a safe same-statement tiebreak.
  WITH ranked AS (
    SELECT cc.ctid,
           EXISTS (
             SELECT 1 FROM board_circuits_climbs cc3
              WHERE cc3.board_type = 'moonboard' AND cc3.circuit_uuid = cc.circuit_uuid AND cc3.climb_uuid = m.canonical_uuid
           ) AS canonical_has_own,
           ROW_NUMBER() OVER (PARTITION BY cc.circuit_uuid, m.canonical_uuid ORDER BY cc.ctid) AS rn
      FROM board_circuits_climbs cc
      JOIN _mad_map m ON m.alias_uuid = cc.climb_uuid
     WHERE cc.board_type = 'moonboard'
  )
  DELETE FROM board_circuits_climbs cc USING ranked r
   WHERE cc.ctid = r.ctid AND (r.canonical_has_own OR r.rn > 1);
  UPDATE board_circuits_climbs cc SET climb_uuid = m.canonical_uuid
    FROM _mad_map m WHERE cc.board_type = 'moonboard' AND cc.climb_uuid = m.alias_uuid;

  WITH ranked AS (
    SELECT cs.id,
           EXISTS (
             SELECT 1 FROM climb_classic_status cs3
              WHERE cs3.board_type = 'moonboard' AND cs3.climb_uuid = m.canonical_uuid
           ) AS canonical_has_own,
           ROW_NUMBER() OVER (PARTITION BY m.canonical_uuid ORDER BY cs.id) AS rn
      FROM climb_classic_status cs
      JOIN _mad_map m ON m.alias_uuid = cs.climb_uuid
     WHERE cs.board_type = 'moonboard'
  )
  DELETE FROM climb_classic_status cs USING ranked r
   WHERE cs.id = r.id AND (r.canonical_has_own OR r.rn > 1);
  UPDATE climb_classic_status cs SET climb_uuid = m.canonical_uuid
    FROM _mad_map m WHERE cs.board_type = 'moonboard' AND cs.climb_uuid = m.alias_uuid;

  -- No surrogate id on this table either; ctid tiebreak again.
  WITH ranked AS (
    SELECT bl.ctid,
           EXISTS (
             SELECT 1 FROM board_beta_links bl3
              WHERE bl3.board_type = 'moonboard' AND bl3.climb_uuid = m.canonical_uuid AND bl3.link = bl.link
           ) AS canonical_has_own,
           ROW_NUMBER() OVER (PARTITION BY bl.link, m.canonical_uuid ORDER BY bl.ctid) AS rn
      FROM board_beta_links bl
      JOIN _mad_map m ON m.alias_uuid = bl.climb_uuid
     WHERE bl.board_type = 'moonboard'
  )
  DELETE FROM board_beta_links bl USING ranked r
   WHERE bl.ctid = r.ctid AND (r.canonical_has_own OR r.rn > 1);
  UPDATE board_beta_links bl SET climb_uuid = m.canonical_uuid
    FROM _mad_map m WHERE bl.board_type = 'moonboard' AND bl.climb_uuid = m.alias_uuid;

  -- 5. Angle-scoped uniqueness tables — same all-members ranking as step 4,
  --    partitioned additionally by each row's OWN angle (not the group
  --    member's "native" angle): _mad_groups guarantees distinct angles
  --    across DIFFERENT members, so a same-angle collision here would only
  --    come from a row at a non-native angle, but nothing enforces that
  --    can't happen, and the ranking handles it for free either way.
  WITH ranked AS (
    SELECT uf.id,
           EXISTS (
             SELECT 1 FROM user_favorites uf3
              WHERE uf3.user_id = uf.user_id AND uf3.board_name = 'moonboard'
                AND uf3.climb_uuid = m.canonical_uuid AND uf3.angle = uf.angle
           ) AS canonical_has_own,
           ROW_NUMBER() OVER (PARTITION BY uf.user_id, m.canonical_uuid, uf.angle ORDER BY uf.id) AS rn
      FROM user_favorites uf
      JOIN _mad_map m ON m.alias_uuid = uf.climb_uuid
     WHERE uf.board_name = 'moonboard'
  )
  DELETE FROM user_favorites uf USING ranked r
   WHERE uf.id = r.id AND (r.canonical_has_own OR r.rn > 1);
  UPDATE user_favorites uf SET climb_uuid = m.canonical_uuid
    FROM _mad_map m WHERE uf.board_name = 'moonboard' AND uf.climb_uuid = m.alias_uuid;

  WITH ranked AS (
    SELECT ccs.id,
           EXISTS (
             SELECT 1 FROM climb_community_status ccs3
              WHERE ccs3.board_type = 'moonboard' AND ccs3.climb_uuid = m.canonical_uuid AND ccs3.angle = ccs.angle
           ) AS canonical_has_own,
           ROW_NUMBER() OVER (PARTITION BY m.canonical_uuid, ccs.angle ORDER BY ccs.id) AS rn
      FROM climb_community_status ccs
      JOIN _mad_map m ON m.alias_uuid = ccs.climb_uuid
     WHERE ccs.board_type = 'moonboard'
  )
  DELETE FROM climb_community_status ccs USING ranked r
   WHERE ccs.id = r.id AND (r.canonical_has_own OR r.rn > 1);
  UPDATE climb_community_status ccs SET climb_uuid = m.canonical_uuid
    FROM _mad_map m WHERE ccs.board_type = 'moonboard' AND ccs.climb_uuid = m.alias_uuid;

  -- 5b. board_climb_ratings — see header: no MoonBoard row can exist today
  -- (only writer hardcodes boardType to Kilter), so this is a defensive no-op
  -- kept in case that ever changes. Same all-members ranking, unique key
  -- (board_type, climb_uuid, angle, user_id).
  WITH ranked AS (
    SELECT bcr.id,
           EXISTS (
             SELECT 1 FROM board_climb_ratings bcr3
              WHERE bcr3.board_type = 'moonboard' AND bcr3.climb_uuid = m.canonical_uuid
                AND bcr3.angle = bcr.angle AND bcr3.user_id = bcr.user_id
           ) AS canonical_has_own,
           ROW_NUMBER() OVER (PARTITION BY bcr.user_id, m.canonical_uuid, bcr.angle ORDER BY bcr.id) AS rn
      FROM board_climb_ratings bcr
      JOIN _mad_map m ON m.alias_uuid = bcr.climb_uuid
     WHERE bcr.board_type = 'moonboard'
  )
  DELETE FROM board_climb_ratings bcr USING ranked r
   WHERE bcr.id = r.id AND (r.canonical_has_own OR r.rn > 1);
  UPDATE board_climb_ratings bcr SET climb_uuid = m.canonical_uuid
    FROM _mad_map m WHERE bcr.board_type = 'moonboard' AND bcr.climb_uuid = m.alias_uuid;

  -- 6. votes + vote_counts. Skip the per-row trigger during the bulk repoint
  --    (same guard rebuildGymVoteCounts() uses in merge-gyms.ts) so it
  --    doesn't do wasted/premature recomputes mid-repoint, dedupe among ALL
  --    members (same ranking shape as steps 4/5 — a user could have voted on
  --    two different losing members), repoint survivors, then rebuild
  --    vote_counts from scratch for every affected canonical using the exact
  --    trigger formula/created_at chain (see header).
  PERFORM set_config('boardsesh.skip_vote_counts', 'on', true);

  WITH ranked AS (
    SELECT v.id,
           EXISTS (
             SELECT 1 FROM votes v3
              WHERE v3.user_id = v.user_id AND v3.entity_type = 'climb' AND v3.entity_id = m.canonical_uuid
           ) AS canonical_has_own,
           ROW_NUMBER() OVER (PARTITION BY v.user_id, m.canonical_uuid ORDER BY v.id) AS rn
      FROM votes v
      JOIN _mad_map m ON m.alias_uuid = v.entity_id
     WHERE v.entity_type = 'climb'
  )
  DELETE FROM votes v USING ranked r
   WHERE v.id = r.id AND (r.canonical_has_own OR r.rn > 1);
  UPDATE votes v SET entity_id = m.canonical_uuid
    FROM _mad_map m WHERE v.entity_type = 'climb' AND v.entity_id = m.alias_uuid;

  DELETE FROM vote_counts vc
   WHERE vc.entity_type = 'climb'
     AND vc.entity_id IN (SELECT uuid FROM _mad_all_ids);

  INSERT INTO vote_counts (entity_type, entity_id, upvotes, downvotes, score, hot_score, created_at)
  SELECT
    vote_totals.entity_type, vote_totals.entity_id, vote_totals.upvotes, vote_totals.downvotes, vote_totals.score,
    SIGN(vote_totals.score) * LN(GREATEST(ABS(vote_totals.score), 1))
      + EXTRACT(EPOCH FROM COALESCE(feed_created_at.created_at, vote_totals.first_vote_created_at, now())) / 45000.0,
    COALESCE(feed_created_at.created_at, vote_totals.first_vote_created_at, now())
  FROM (
    SELECT 'climb'::social_entity_type AS entity_type, m.canonical_uuid AS entity_id,
           SUM(CASE WHEN v.value = 1 THEN 1 ELSE 0 END)::int AS upvotes,
           SUM(CASE WHEN v.value = -1 THEN 1 ELSE 0 END)::int AS downvotes,
           SUM(v.value)::int AS score,
           MIN(v.created_at) AS first_vote_created_at
      FROM votes v
      JOIN (SELECT DISTINCT canonical_uuid FROM _mad_map) m ON m.canonical_uuid = v.entity_id
     WHERE v.entity_type = 'climb'
     GROUP BY m.canonical_uuid
  ) vote_totals
  LEFT JOIN LATERAL (
    SELECT fi.created_at FROM feed_items fi
     WHERE fi.entity_type = vote_totals.entity_type AND fi.entity_id = vote_totals.entity_id
     ORDER BY fi.created_at ASC, fi.id ASC LIMIT 1
  ) feed_created_at ON true;

  PERFORM set_config('boardsesh.skip_vote_counts', 'off', true);

  -- 7. Recommendation/ML caches (see header for why dropping, not merging,
  --    is correct here).
  DELETE FROM board_climb_embeddings be USING _mad_map m
   WHERE be.board_type = 'moonboard' AND be.climb_uuid = m.alias_uuid;

  DELETE FROM board_climb_similar bs USING _mad_map m
   WHERE bs.board_type = 'moonboard' AND (bs.climb_uuid = m.alias_uuid OR bs.neighbor_uuid = m.alias_uuid);

  -- board_climb_send_stats has no angle dimension (PK is board_type+climb_uuid)
  -- and is a small PostHog-mined trending aggregate with no guaranteed
  -- near-term rebuild (unlike embeddings/similarity above), so its counts are
  -- merged rather than dropped. send_count_30d/90d are true event counts, so
  -- they sum cleanly. sender_count_30d is a DISTINCT-sender count we can't
  -- deduplicate here without the raw per-user PostHog rows (this migration
  -- only has each angle-row's already-aggregated count) — GREATEST is a
  -- deliberate conservative floor (correct if the two angle-rows' senders
  -- fully overlap, an undercount if they don't) rather than SUM, which would
  -- double-count any climber who sent both angle variants. Acceptable given
  -- the table's own "safe to be stale" contract; the next nightly job
  -- recomputes it properly from raw events regardless.
  INSERT INTO board_climb_send_stats (board_type, climb_uuid, send_count_30d, sender_count_30d, send_count_90d, last_sent_at, updated_at)
  SELECT s.board_type, m.canonical_uuid, s.send_count_30d, s.sender_count_30d, s.send_count_90d, s.last_sent_at, now()
    FROM board_climb_send_stats s
    JOIN _mad_map m ON m.alias_uuid = s.climb_uuid
   WHERE s.board_type = 'moonboard'
  ON CONFLICT (board_type, climb_uuid) DO UPDATE SET
    send_count_30d = board_climb_send_stats.send_count_30d + excluded.send_count_30d,
    sender_count_30d = GREATEST(board_climb_send_stats.sender_count_30d, excluded.sender_count_30d),
    send_count_90d = board_climb_send_stats.send_count_90d + excluded.send_count_90d,
    last_sent_at = GREATEST(board_climb_send_stats.last_sent_at, excluded.last_sent_at),
    updated_at = now();

  DELETE FROM board_climb_send_stats s USING _mad_map m
   WHERE s.board_type = 'moonboard' AND s.climb_uuid = m.alias_uuid;

  -- 8. Delist the non-canonical rows. Never DELETE (see header): their
  --    board_climb_holds/self-alias rows stay in place as harmless, unlisted
  --    history.
  UPDATE board_climbs
     SET is_listed = false
   WHERE board_type = 'moonboard'
     AND uuid IN (SELECT alias_uuid FROM _mad_map);

  INSERT INTO _bs_migration_guards (tag) VALUES ('0188_moonboard_angle_dedup_backfill');

  RAISE NOTICE 'moonboard angle dedup: merged % non-canonical row(s) across % group(s); left % same-angle-collision group(s) untouched',
    v_merged, v_groups, v_skipped_ambiguous;
END $$;
