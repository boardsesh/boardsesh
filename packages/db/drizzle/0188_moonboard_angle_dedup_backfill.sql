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
-- onto it (source='moonboard-angle-dedup'), re-key each member's own
-- board_climb_stats row onto the canonical (preserving its angle), repoint
-- every table that references a climb UUID, and DELIST (never DELETE) the
-- non-canonical board_climbs rows — deleting them would CASCADE-drop their
-- board_climb_holds/board_climb_aliases rows, none of which need removing
-- since nothing downstream reads a delisted row directly. Fenced to catalog
-- rows (user_id IS NULL) throughout, exactly like 0163: a user-created
-- single-angle MoonBoard climb is never grouped, aliased, delisted, or
-- repointed by this migration.
--
-- Explicitly NOT touched (left pointing at their original uuid):
--   * sync_deletions — an append-only log of deletions that already
--     happened; its encoded climb_uuid is a historical fact, not a live
--     reference, so it stays as originally recorded.
--   * app_feedback.context.climbUuid — informational JSONB, not a real
--     relational reference.
--   * board_climb_ratings — structurally CANNOT contain a moonboard row: its
--     only writer in the whole codebase (packages/kilter-sync/src/sync/
--     user-sync.ts) hardcodes boardType to KILTER_BOARD_TYPE. Verified by
--     reading every insert into this table, not inferred from a prod count
--     (no prod DB access at authoring time) — grep `insert(boardClimbRatings`
--     across the repo to re-confirm if this ever changes.
-- (board_climb_stats_history IS repointed below, unlike 0163/0165/0166's
-- ticks-merge migrations — this one never deletes a climb row, so repointing
-- the audit trail is safe and keeps it queryable from the canonical uuid.)
--
-- vote_counts.hot_score has no scheduled recompute job (verified: no cron/
-- workflow touches it), so it is recomputed here inline using the exact
-- Reddit-style formula from refresh_vote_counts() (0053_add_vote_counts.sql):
--   hot_score = SIGN(score) * LN(GREATEST(ABS(score), 1))
--             + EXTRACT(EPOCH FROM (created_at - TIMESTAMP '2005-12-08')) / 45000.0
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
  UPDATE board_climb_aliases a
     SET canonical_uuid = m.canonical_uuid, last_seen_at = now()
    FROM _mad_map m
   WHERE a.board_type = 'moonboard' AND a.canonical_uuid = m.alias_uuid;

  INSERT INTO board_climb_aliases (board_type, alias_uuid, canonical_uuid, source)
  SELECT 'moonboard', alias_uuid, canonical_uuid, 'moonboard-angle-dedup' FROM _mad_map
  ON CONFLICT (board_type, alias_uuid) DO UPDATE
    SET canonical_uuid = excluded.canonical_uuid, last_seen_at = now();

  -- 2. Re-key board_climb_stats onto the canonical uuid, ONE ROW PER
  --    ORIGINAL ANGLE — angles are never combined (see header). ON CONFLICT
  --    is defensive only: _mad_groups guarantees no two members of one group
  --    share an angle, so the canonical's own pre-existing stats row (same
  --    uuid, same angle) is the only possible conflict target, and that's a
  --    same-row no-op via the COALESCE/GREATEST below.
  INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, benchmark_difficulty,
         ascensionist_count, upstream_ascensionist_count, boardsesh_ascensionist_count, difficulty_average,
         quality_average, upstream_quality_average, quality_normalized, fa_username, fa_at, upstream_synced_at)
  SELECT s.board_type, m.canonical_uuid, s.angle, s.display_difficulty, s.benchmark_difficulty,
         s.ascensionist_count, s.upstream_ascensionist_count, s.boardsesh_ascensionist_count, s.difficulty_average,
         s.quality_average, s.upstream_quality_average, s.quality_normalized, s.fa_username, s.fa_at, s.upstream_synced_at
    FROM board_climb_stats s
    JOIN _mad_map m ON m.alias_uuid = s.climb_uuid AND m.angle = s.angle
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

  -- The row just copied onto the canonical uuid now fully duplicates the
  -- retiring uuid's own stats row (same board_type/angle, identical values) —
  -- drop the original so nothing that scans board_climb_stats broadly (a
  -- leaderboard, a bulk recompute) double-counts a delisted climb's ascents.
  -- Safe: every value has already been copied forward by the INSERT above.
  DELETE FROM board_climb_stats s USING _mad_map m
   WHERE s.board_type = 'moonboard' AND s.climb_uuid = m.alias_uuid AND s.angle = m.angle;

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
  --    real collision is possible (a user interacted with both angle-rows of
  --    the same problem): drop the losing duplicate, then repoint the
  --    survivor. Same shape as 0163's playlist_climbs step.
  DELETE FROM playlist_climbs pc USING _mad_map m
   WHERE pc.climb_uuid = m.alias_uuid
     AND EXISTS (
       SELECT 1 FROM playlist_climbs pc2
        WHERE pc2.playlist_id = pc.playlist_id AND pc2.climb_uuid = m.canonical_uuid
     );
  UPDATE playlist_climbs pc SET climb_uuid = m.canonical_uuid
    FROM _mad_map m WHERE pc.climb_uuid = m.alias_uuid;

  -- A collision here can leave a gap in the circuit's position sequence
  -- (the dropped alias's slot isn't resequenced) — accepted: position only
  -- drives ORDER BY for circuit member display, which doesn't need contiguity.
  DELETE FROM board_circuits_climbs cc USING _mad_map m
   WHERE cc.board_type = 'moonboard' AND cc.climb_uuid = m.alias_uuid
     AND EXISTS (
       SELECT 1 FROM board_circuits_climbs cc2
        WHERE cc2.board_type = 'moonboard' AND cc2.circuit_uuid = cc.circuit_uuid AND cc2.climb_uuid = m.canonical_uuid
     );
  UPDATE board_circuits_climbs cc SET climb_uuid = m.canonical_uuid
    FROM _mad_map m WHERE cc.board_type = 'moonboard' AND cc.climb_uuid = m.alias_uuid;

  DELETE FROM climb_classic_status cs USING _mad_map m
   WHERE cs.board_type = 'moonboard' AND cs.climb_uuid = m.alias_uuid
     AND EXISTS (
       SELECT 1 FROM climb_classic_status cs2
        WHERE cs2.board_type = 'moonboard' AND cs2.climb_uuid = m.canonical_uuid
     );
  UPDATE climb_classic_status cs SET climb_uuid = m.canonical_uuid
    FROM _mad_map m WHERE cs.board_type = 'moonboard' AND cs.climb_uuid = m.alias_uuid;

  DELETE FROM board_beta_links bl USING _mad_map m
   WHERE bl.board_type = 'moonboard' AND bl.climb_uuid = m.alias_uuid
     AND EXISTS (
       SELECT 1 FROM board_beta_links bl2
        WHERE bl2.board_type = 'moonboard' AND bl2.climb_uuid = m.canonical_uuid AND bl2.link = bl.link
     );
  UPDATE board_beta_links bl SET climb_uuid = m.canonical_uuid
    FROM _mad_map m WHERE bl.board_type = 'moonboard' AND bl.climb_uuid = m.alias_uuid;

  -- 5. Angle-scoped uniqueness tables: a collision is not expected (angle
  --    differs by construction — _mad_groups guarantees distinct angles per
  --    group) but the dedupe-then-update shape costs nothing extra, so it's
  --    kept for defense-in-depth.
  DELETE FROM user_favorites uf USING _mad_map m
   WHERE uf.board_name = 'moonboard' AND uf.climb_uuid = m.alias_uuid AND uf.angle = m.angle
     AND EXISTS (
       SELECT 1 FROM user_favorites uf2
        WHERE uf2.user_id = uf.user_id AND uf2.board_name = 'moonboard'
          AND uf2.climb_uuid = m.canonical_uuid AND uf2.angle = m.angle
     );
  UPDATE user_favorites uf SET climb_uuid = m.canonical_uuid
    FROM _mad_map m WHERE uf.board_name = 'moonboard' AND uf.climb_uuid = m.alias_uuid;

  DELETE FROM climb_community_status ccs USING _mad_map m
   WHERE ccs.board_type = 'moonboard' AND ccs.climb_uuid = m.alias_uuid AND ccs.angle = m.angle
     AND EXISTS (
       SELECT 1 FROM climb_community_status ccs2
        WHERE ccs2.board_type = 'moonboard' AND ccs2.climb_uuid = m.canonical_uuid AND ccs2.angle = m.angle
     );
  UPDATE climb_community_status ccs SET climb_uuid = m.canonical_uuid
    FROM _mad_map m WHERE ccs.board_type = 'moonboard' AND ccs.climb_uuid = m.alias_uuid;

  -- 6. votes: drop the losing duplicate (a user who voted on both angle-rows
  --    keeps only their canonical-row vote), repoint survivors, then
  --    recompute vote_counts for every affected climb using the exact
  --    Reddit-hot formula (see header) — there is no scheduled job that
  --    recomputes hot_score, so leaving it stale here would never self-heal.
  DELETE FROM votes v USING _mad_map m
   WHERE v.entity_type = 'climb' AND v.entity_id = m.alias_uuid
     AND EXISTS (
       SELECT 1 FROM votes v2
        WHERE v2.user_id = v.user_id AND v2.entity_type = 'climb' AND v2.entity_id = m.canonical_uuid
     );
  UPDATE votes v SET entity_id = m.canonical_uuid
    FROM _mad_map m WHERE v.entity_type = 'climb' AND v.entity_id = m.alias_uuid;

  WITH created AS (
    SELECT ai.canonical_uuid, MIN(vc.created_at) AS created_at
      FROM _mad_all_ids ai
      JOIN vote_counts vc ON vc.entity_type = 'climb' AND vc.entity_id = ai.uuid
     GROUP BY ai.canonical_uuid
  ),
  agg AS (
    SELECT ai.canonical_uuid,
           COUNT(*) FILTER (WHERE v.value = 1)  AS upvotes,
           COUNT(*) FILTER (WHERE v.value = -1) AS downvotes
      FROM (SELECT DISTINCT canonical_uuid FROM _mad_map) ai
      LEFT JOIN votes v ON v.entity_type = 'climb' AND v.entity_id = ai.canonical_uuid
     GROUP BY ai.canonical_uuid
  )
  INSERT INTO vote_counts (entity_type, entity_id, upvotes, downvotes, score, hot_score, created_at)
  SELECT 'climb', agg.canonical_uuid, agg.upvotes, agg.downvotes, agg.upvotes - agg.downvotes,
         SIGN(agg.upvotes - agg.downvotes) * LN(GREATEST(ABS(agg.upvotes - agg.downvotes), 1))
           + EXTRACT(EPOCH FROM (COALESCE(created.created_at, now()) - TIMESTAMP '2005-12-08')) / 45000.0,
         COALESCE(created.created_at, now())
    FROM agg
    LEFT JOIN created ON created.canonical_uuid = agg.canonical_uuid
   -- Skip canonicals with no real vote data: recompute, don't invent. Without
   -- this, a climb neither side ever voted on gets a spurious 0/0/0 ghost row
   -- (agg's LEFT JOIN votes still produces a zero-count row for every
   -- canonical in _mad_map, and created's INNER JOIN finds nothing for it).
   WHERE agg.upvotes > 0 OR agg.downvotes > 0 OR created.canonical_uuid IS NOT NULL
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET
    upvotes = excluded.upvotes, downvotes = excluded.downvotes, score = excluded.score,
    hot_score = excluded.hot_score, created_at = excluded.created_at;

  DELETE FROM vote_counts vc USING _mad_map m
   WHERE vc.entity_type = 'climb' AND vc.entity_id = m.alias_uuid;

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
