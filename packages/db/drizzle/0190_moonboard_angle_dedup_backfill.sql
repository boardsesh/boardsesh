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
-- repoint every table that references a climb UUID, recompute the Boardsesh
-- half of board_climb_stats from the repointed ticks, and DELIST (never
-- DELETE) the non-canonical board_climbs rows — deleting them would
-- CASCADE-drop their board_climb_holds/board_climb_aliases rows, none of
-- which need removing since nothing downstream reads a delisted row
-- directly. Fenced to catalog rows (user_id IS NULL) throughout, exactly
-- like 0163: a user-created single-angle MoonBoard climb is never grouped,
-- aliased, delisted, or repointed by this migration.
--
-- STATS ARE RECOUNTED, NOT ARITHMETIC (step 3b). board_climb_stats
-- materializes two invariants that a row-level merge cannot preserve on its
-- own, both documented on boardClimbStats in
-- packages/db/src/schema/boards/unified.ts:
--   ascensionist_count = upstream_ascensionist_count + boardsesh_ascensionist_count
--   quality_average    = the blend of the upstream average and Boardsesh's own
--                        star ratings (blendedQualityAverageSql,
--                        packages/db/src/queries/climb-stats/quality-blend.ts)
-- boardsesh_ascensionist_count counts DISTINCT climbers, so neither SUM nor
-- GREATEST is right when two angle-rows merge: a climber who ticked BOTH
-- aliases at the same angle is ONE ascensionist afterwards (SUM double-counts
-- them), and two different climbers who each ticked a different alias are TWO
-- (GREATEST loses one). The two steps own disjoint halves of the row:
--   * step 2 places the row and merges the UPSTREAM half (the catalog's own
--     numbers), rewriting ascensionist_count in the same statement so the
--     materialized invariant holds on the row it leaves behind;
--   * step 3b owns boardsesh_ascensionist_count, boardsesh_quality_sum,
--     boardsesh_quality_count, quality_average and ascensionist_count for
--     EVERY key step 2 touched, re-deriving them from the repointed ticks by
--     porting recomputeClimbStatsBulk()
--     (packages/db/src/queries/climb-stats/recompute.ts) — the same code the
--     backend runs after every tick write.
-- Step 2 therefore never imports the alias's Boardsesh half onto the
-- canonical: an earlier version did, and on any key 3b then skipped that
-- promoted a stale tick-less count onto the surviving climb permanently.
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
-- with a unique-constraint violation on deploy. The same class of abort hits
-- the two upserts (board_climb_stats, board_climb_send_stats), where two
-- alias rows landing on one target key trip "ON CONFLICT DO UPDATE command
-- cannot affect row a second time"; both fold their aliases together before
-- the upsert rather than feeding raw rows in.
--
-- WHICH ROW SURVIVES A COLLISION is a product decision, not a tiebreak: a
-- climber opens the app after this migration and sees whatever we kept. Per
-- table (each stated again on its own ORDER BY, so one can be re-argued
-- without touching the others):
--   votes                  -> the user's LATEST vote — their current opinion,
--                             not the one they already changed their mind about
--   user_favorites         -> the EARLIEST row — preserves "when I first
--                             starred this"
--   playlist_climbs        -> the EARLIEST row, keeping its earliest position
--   board_circuits_climbs  -> the EARLIEST row (lowest position; no timestamp)
--   climb_classic_status   -> canonical's own, else the strongest signal
--   climb_community_status -> canonical's own, else the strongest signal
--   board_beta_links       -> canonical's own, else the strongest signal
--   board_climb_ratings    -> canonical's own, else lowest id (dead code, 5b)
--   board_climb_grades     -> canonical's own, else lowest computed_at (5c)
--
-- OFFLINE CLIENTS. Deletions reach devices through sync_deletions tombstones
-- written by AFTER DELETE triggers (0144/0146/0147); repoints and delists
-- reach them through the (updated_at, sync_seq) cursors that BEFORE UPDATE
-- triggers stamp. This migration deliberately does NOT set
-- boardsesh.suppress_sync_tombstones (the guard clear-aurora-board.ts uses for
-- a bulk re-import) and does NOT hand-stamp updated_at/sync_seq — both would
-- strand rows on every device. Two cases the triggers cannot cover on their
-- own, handled explicitly in steps 4/5:
--   * user_favorites and playlist_climbs are keyed LOCALLY by climb_uuid
--     ((board_name, climb_uuid, angle) and (playlist_uuid, climb_uuid) — see
--     packages/shared/offline-sync/src/sync/table-config.ts), so a repoint
--     MOVES a row's client primary key while firing no delete trigger. Rows
--     that survive but move get a hand-written sync_deletions row for the key
--     they vacate, in each trigger's exact record_id format.
--   * boardsesh_ticks is keyed locally by `uuid`, which no repoint touches, so
--     its cursor bump alone is enough — no tombstone.
--
-- Explicitly NOT touched (left pointing at their original uuid):
--   * sync_deletions — an append-only log of deletions that already
--     happened; its encoded climb_uuid is a historical fact, not a live
--     reference, so it stays as originally recorded.
--   * app_feedback.context.climbUuid — informational JSONB, not a real
--     relational reference.
--   * logbook_sync_skips — keyed on (user_id, board_type, aurora_type,
--     aurora_id); it records upstream Aurora rows that failed to import and
--     has no climb_uuid column at all. Nothing to repoint.
--   * board_climb_ingest_skips — a diagnostic record of climbs a catalog sync
--     could NOT ingest, keyed (board_type, climb_uuid). Its rows are, by
--     definition, about uuids that never became a board_climbs row, so they
--     can't name a group member; and like sync_deletions it is a log of what
--     happened, not a live reference.
--   * board_session_queues.queue / current_climb_queue_item — JSONB snapshots
--     of an in-progress session's queue, not relational references. A live
--     session's queue item keeps resolving through board_climb_aliases; a
--     finished session's is history.
--   * integration_exports — records a Strava/HealthKit push per (provider,
--     user, session); it carries no climb reference.
-- board_climb_ratings (step 5b) and board_climb_grades (step 5c) ARE
-- defensively repointed even though neither can structurally contain a
-- moonboard row today:
--   * board_climb_ratings — its only writer in the whole codebase
--     (packages/kilter-sync/src/sync/user-sync.ts) hardcodes boardType to
--     KILTER_BOARD_TYPE (verified by reading every insert into this table).
--   * board_climb_grades — its only Postgres writer,
--     packages/db/scripts/refresh-climb-grades.ts, only ever loops over
--     CROWD_MEAN_BOARDS (packages/db/src/queries/grade-model/constants.ts:
--     kilter, tension, grasshopper, decoy, soill, touchstone — MoonBoard is
--     deliberately absent because Moon's feed carries only integer labels, so
--     there is no crowd mean to model; see docs/boardsesh-grade.md §5). There
--     is no --board override. PR #4347 (2026-08-12) changed only the CLIENT
--     import of the grades snapshot artifact, not who produces grade rows, and
--     its own measurements record production as "moonboard:2 … zero grade
--     rows". Repointed anyway because the failure would be silent and
--     permanent if that ever changed: climb_uuid is part of this table's
--     primary key, there is no FK/cascade from board_climbs, and
--     deleteStaleGrades is itself scoped to CROWD_MEAN_BOARDS, so an orphaned
--     MoonBoard grade row would never be reaped by anything.
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
-- simply dropped rather than merged.
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
-- ⚠️ DEPLOY ORDERING: do NOT run packages/db/scripts/import-moonboard-catalog.ts
-- against a database this migration has touched until the angle-agnostic
-- importer rewrite (#3851) has landed. As of 2026-08-12 #3851 is still OPEN —
-- verified against origin/main, which has no commit referencing it — so the
-- importer on main is the pre-#3851 one and this is a live constraint, not a
-- historical note. The three orderings:
--   1. importer -> this migration (SAFE, and the only ordering that needs no
--      coordination): a catalog run before the merge sees the pre-merge world
--      it was written for.
--   2. this migration -> #3851's importer -> catalog import (SAFE, the target
--      state): #3851 mints one angle-agnostic uuid per problem, drops angle
--      from the match key, and adds an ambiguity guard that skips a problem
--      with a loud message rather than re-minting.
--   3. this migration -> pre-#3851 importer (UNSAFE, and it FAILS OPEN — the
--      importer prints nothing and exits 0). The pre-#3851 importer matches on
--      (layout_id, angle, hold_fingerprint) and builds its match index only
--      from rows with is_listed = true, so a problem whose 25° row this
--      migration delisted finds no match, re-mints moonboard:{id}:{angle}, and
--      then its alias upsert — catalogAliasConflictUpdate(), an unconditional
--      canonical_uuid = excluded.canonical_uuid — repoints the SURVIVING row's
--      self-alias at that freshly minted empty climb. That redirects the
--      problem's ticks and logbook resolution onto a climb with no stats and
--      no history, and re-creates a stats row under the delisted uuid. There
--      is no guard against this on main; ordering discipline is the only
--      protection until #3851 merges.
--
-- Prod group/member counts are NOT pre-verified for this migration (no live
-- prod DB access at authoring time). Replayed against the pre-built dev-db
-- image (ghcr.io/boardsesh/boardsesh-dev-db) via `vp run db:up`, which DOES
-- carry real per-angle MoonBoard catalog duplication (contrary to an earlier
-- version of this comment that assumed otherwise). Latest run, 2026-08-12:
--   766 non-canonical rows merged across 766 groups
--   478 same-angle-collision groups correctly left untouched
--   0 errors; 0 listed alias rows left; 0 stats rows under a retired uuid;
--   0 orphaned tick references; 766 board_climb_stats tombstones written;
--   0 rows violating ascensionist_count = upstream + boardsesh, on MoonBoard
--     and on every other board;
--   767 canonical climbs now carrying more than one stats angle.
-- That run's ticks/votes/favourites/playlist tables had no rows landing on a
-- losing (non-canonical) member, so it validates the structural/grouping
-- logic and the tombstone plumbing on real data, but not the collision
-- policies, the stats recompute or the vote_counts rebuild under real load —
-- those are covered by the scratch-Postgres replay fixture
-- (moonboard-angle-dedup-replay.ts, CASE A-F). Dev-db counts are NOT a
-- substitute for prod sizing (dev is a small fixed snapshot, not
-- representative of prod scale/shape) — still run a read-only sizing query
-- against prod (see the _mad_groups/_mad_raw_groups shape below) before
-- deploying, and update this comment with those numbers per repo convention.

CREATE TABLE IF NOT EXISTS _bs_migration_guards (
  tag text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

DO $$
DECLARE
  v_groups bigint;
  v_skipped_ambiguous bigint;
  v_merged bigint;
  v_recomputed bigint;
  v_tombstones bigint;
  v_tombstone_watermark bigint;
BEGIN
  -- Watermark, not a timestamp: sync_deletions.deleted_at defaults to now(),
  -- which inside a transaction is the transaction's start — already in the
  -- past by the time this line runs, so a clock_timestamp() cutoff would
  -- count zero. The surrogate id is exact and has no such trap.
  SELECT COALESCE(max(id), 0) INTO v_tombstone_watermark FROM sync_deletions;

  IF EXISTS (SELECT 1 FROM _bs_migration_guards WHERE tag = '0190_moonboard_angle_dedup_backfill') THEN
    RAISE NOTICE '0190 moonboard angle dedup already applied — skipping (guard row present)';
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

  -- All (canonical_uuid, member_uuid) pairs INCLUDING the self-pair. This is
  -- the collision-ranking input for steps 4/5: ranking has to see the
  -- canonical's own row alongside every alias's, or two aliases that collide
  -- only with each other slip through. Also used to find every vote_counts
  -- row feeding the hot_score rebuild in step 6.
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
  --    after — orthogonal to what this migration does. No evidence this shape exists in
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
  --    canonical.
  --
  --    Alias rows are collapsed to ONE row per (canonical, angle) FIRST. Two
  --    DIFFERENT alias members can each hold a stats row at the SAME angle
  --    (only their NATIVE angles are guaranteed distinct — see the non-native
  --    row above), and `ON CONFLICT DO UPDATE` cannot touch the same target
  --    row twice in one statement ("ON CONFLICT DO UPDATE command cannot
  --    affect row a second time"), so feeding the raw rows straight in would
  --    abort the whole migration on deploy. Same alias-vs-alias collision
  --    class steps 4/5 rank away; this table merges instead of dropping.
  --    Ranking for the "first non-null wins" columns: the member whose own
  --    board_climbs.angle equals the stats row's angle first (that's the row
  --    the catalog actually graded), then most upstream ascents, then uuid.
  CREATE TEMP TABLE _mad_stats_src ON COMMIT DROP AS
    SELECT canonical_uuid, angle,
           (array_agg(display_difficulty ORDER BY rank) FILTER (WHERE display_difficulty IS NOT NULL))[1] AS display_difficulty,
           (array_agg(benchmark_difficulty ORDER BY rank) FILTER (WHERE benchmark_difficulty IS NOT NULL))[1] AS benchmark_difficulty,
           max(upstream_ascensionist_count) AS upstream_ascensionist_count,
           max(boardsesh_ascensionist_count) AS boardsesh_ascensionist_count,
           (array_agg(difficulty_average ORDER BY rank) FILTER (WHERE difficulty_average IS NOT NULL))[1] AS difficulty_average,
           (array_agg(quality_average ORDER BY rank) FILTER (WHERE quality_average IS NOT NULL))[1] AS quality_average,
           (array_agg(upstream_quality_average ORDER BY rank) FILTER (WHERE upstream_quality_average IS NOT NULL))[1] AS upstream_quality_average,
           (array_agg(boardsesh_quality_sum ORDER BY rank) FILTER (WHERE boardsesh_quality_sum IS NOT NULL))[1] AS boardsesh_quality_sum,
           (array_agg(boardsesh_quality_count ORDER BY rank) FILTER (WHERE boardsesh_quality_count IS NOT NULL))[1] AS boardsesh_quality_count,
           bool_or(quality_normalized) AS quality_normalized,
           (array_agg(fa_username ORDER BY rank) FILTER (WHERE fa_username IS NOT NULL))[1] AS fa_username,
           (array_agg(fa_at ORDER BY rank) FILTER (WHERE fa_at IS NOT NULL))[1] AS fa_at,
           max(upstream_synced_at) AS upstream_synced_at
      FROM (
        SELECT m.canonical_uuid, s.angle, s.display_difficulty, s.benchmark_difficulty,
               s.upstream_ascensionist_count, s.boardsesh_ascensionist_count, s.difficulty_average,
               s.quality_average, s.upstream_quality_average, s.boardsesh_quality_sum,
               s.boardsesh_quality_count, s.quality_normalized, s.fa_username, s.fa_at,
               s.upstream_synced_at,
               ROW_NUMBER() OVER (
                 PARTITION BY m.canonical_uuid, s.angle
                 ORDER BY (s.angle = m.angle) DESC,
                          COALESCE(s.upstream_ascensionist_count, 0) DESC,
                          s.climb_uuid ASC
               ) AS rank
          FROM board_climb_stats s
          JOIN _mad_map m ON m.alias_uuid = s.climb_uuid
         WHERE s.board_type = 'moonboard'
      ) ranked
     GROUP BY canonical_uuid, angle;

  --    SINGLE-OWNER CONTRACT for the recompute-owned columns. This statement
  --    places the row and merges the UPSTREAM half; step 3b below owns
  --    boardsesh_ascensionist_count, boardsesh_quality_sum,
  --    boardsesh_quality_count, quality_average and ascensionist_count for
  --    EVERY key this statement writes — INSERT and ON CONFLICT alike, captured
  --    by the RETURNING below and handed to 3b with no tick-presence filter.
  --    So the conflict branch deliberately does NOT import the alias's
  --    Boardsesh half onto the canonical. An earlier version did, with
  --    GREATEST/COALESCE, and on any key 3b then skipped that published a stale
  --    tick-less Boardsesh count as the surviving climb's ascent number and
  --    left quality_average off its own blend inputs (the contract
  --    blendedQualityAverageSql states in
  --    packages/db/src/queries/climb-stats/quality-blend.ts). With 3b covering
  --    every written key, a merge policy for those columns is a published wrong
  --    number at worst and, at best, still not free: writing a value 3b then
  --    writes straight back moves the row's (updated_at, sync_seq) cursor, so
  --    every offline device re-pulls a row whose published values never changed.
  --      * upstream_ascensionist_count: GREATEST is right, and step 2 owns it —
  --        both rows observe the SAME upstream community-repeat count for one
  --        physical problem, so the larger is the more complete import, never a
  --        second cohort.
  --      * ascensionist_count is still rewritten here, as the merged upstream
  --        plus the canonical's OWN Boardsesh half, so the materialized
  --        invariant (documented on boardClimbStats in
  --        packages/db/src/schema/boards/unified.ts) holds on the row this
  --        statement leaves behind rather than only after 3b. Merging all three
  --        ascent columns independently with GREATEST (as an even earlier
  --        version did) can produce a total that is not upstream + boardsesh.
  --      * boardsesh_ascensionist_count counts DISTINCT climbers, so no
  --        row-level arithmetic can be right: a climber who ticked BOTH aliases
  --        at the same angle is ONE ascensionist after the merge (SUM
  --        double-counts them) and two climbers who each ticked a different
  --        alias are TWO (GREATEST loses one). Only 3b's recount from the
  --        repointed ticks lands on the right number.
  --    The INSERT path still copies the alias's Boardsesh columns verbatim. 3b
  --    overwrites them on the same key moments later, so the copy changes no
  --    outcome today; it is there so this statement is self-consistent on its
  --    own, and so a future edit that narrows 3b degrades to "the re-keyed row
  --    kept its provenance" instead of "the re-keyed row silently nulled it".
  CREATE TEMP TABLE _mad_written_stats_keys ON COMMIT DROP AS
  WITH written AS (
    INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, benchmark_difficulty,
           ascensionist_count, upstream_ascensionist_count, boardsesh_ascensionist_count, difficulty_average,
           quality_average, upstream_quality_average, boardsesh_quality_sum, boardsesh_quality_count,
           quality_normalized, fa_username, fa_at, upstream_synced_at)
    SELECT 'moonboard', src.canonical_uuid, src.angle, src.display_difficulty, src.benchmark_difficulty,
           COALESCE(src.upstream_ascensionist_count, 0) + COALESCE(src.boardsesh_ascensionist_count, 0),
           src.upstream_ascensionist_count, src.boardsesh_ascensionist_count, src.difficulty_average,
           src.quality_average, src.upstream_quality_average, src.boardsesh_quality_sum,
           src.boardsesh_quality_count, src.quality_normalized, src.fa_username, src.fa_at,
           src.upstream_synced_at
      FROM _mad_stats_src src
    ON CONFLICT (board_type, climb_uuid, angle) DO UPDATE SET
      display_difficulty = COALESCE(board_climb_stats.display_difficulty, excluded.display_difficulty),
      benchmark_difficulty = COALESCE(board_climb_stats.benchmark_difficulty, excluded.benchmark_difficulty),
      upstream_ascensionist_count = GREATEST(COALESCE(board_climb_stats.upstream_ascensionist_count, 0), COALESCE(excluded.upstream_ascensionist_count, 0)),
      ascensionist_count =
        GREATEST(COALESCE(board_climb_stats.upstream_ascensionist_count, 0), COALESCE(excluded.upstream_ascensionist_count, 0))
        + COALESCE(board_climb_stats.boardsesh_ascensionist_count, 0),
      difficulty_average = COALESCE(board_climb_stats.difficulty_average, excluded.difficulty_average),
      upstream_quality_average = COALESCE(board_climb_stats.upstream_quality_average, excluded.upstream_quality_average),
      fa_username = COALESCE(board_climb_stats.fa_username, excluded.fa_username),
      fa_at = COALESCE(board_climb_stats.fa_at, excluded.fa_at),
      quality_normalized = board_climb_stats.quality_normalized OR excluded.quality_normalized,
      upstream_synced_at = GREATEST(board_climb_stats.upstream_synced_at, excluded.upstream_synced_at)
    RETURNING board_climb_stats.climb_uuid, board_climb_stats.angle
  )
  SELECT DISTINCT climb_uuid, angle FROM written;

  -- The rows just copied onto the canonical uuid now fully duplicate the
  -- retiring uuid's own stats rows (same board_type/angle, identical values) —
  -- drop the originals so nothing that scans board_climb_stats broadly (a
  -- leaderboard, a bulk recompute) double-counts a delisted climb's ascents.
  -- Safe: every value has already been copied forward by the INSERT above.
  DELETE FROM board_climb_stats s USING _mad_map m
   WHERE s.board_type = 'moonboard' AND s.climb_uuid = m.alias_uuid;

  -- 3. Plain repoints — climb_uuid moves to canonical, each row's own
  --    angle/value is untouched, no uniqueness collision is possible.
  --
  --    Ticks are captured as they move: step 3b below has to recompute the
  --    Boardsesh half of board_climb_stats for every key that now owns a
  --    repointed tick, and after the UPDATE there is no way to tell a
  --    just-moved tick from one that was always on the canonical.
  --    Offline propagation: trg_boardsesh_ticks_set_updated_at (0146) stamps
  --    updated_at on any change outside its excluded column set (climb_uuid is
  --    NOT excluded), so the cursor moves and syncTicks re-ships the row. No
  --    sync_deletions tombstone is needed here: the mobile local primary key
  --    for boardsesh_ticks is `uuid` (packages/shared/offline-sync/src/sync/
  --    table-config.ts), which this repoint does not touch, so the client
  --    updates the row in place rather than stranding one at an old key.
  CREATE TEMP TABLE _mad_repointed_tick_keys ON COMMIT DROP AS
  WITH moved AS (
    UPDATE boardsesh_ticks t SET climb_uuid = m.canonical_uuid
      FROM _mad_map m WHERE t.board_type = 'moonboard' AND t.climb_uuid = m.alias_uuid
    RETURNING t.climb_uuid, t.angle
  )
  SELECT DISTINCT climb_uuid, angle FROM moved;

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

  -- 3b. Recompute the BOARDSESH half of board_climb_stats for every key this
  --     migration touched. Step 2's row-level merge cannot get this right on
  --     its own: boardsesh_ascensionist_count is a count of DISTINCT climbers,
  --     so a climber who ticked BOTH aliases at the same angle is ONE
  --     ascensionist after the merge — SUM would double-count them, GREATEST
  --     would lose a second climber who only ticked the other alias. The only
  --     correct answer is to recount from the ticks, which step 3 has just
  --     finished repointing onto the canonical.
  --
  --     Ported faithfully from recomputeClimbStatsBulk() in
  --     packages/db/src/queries/climb-stats/recompute.ts (the same code the
  --     backend runs after every tick write, via
  --     packages/backend/src/graphql/resolvers/ticks/recompute-climb-stats.ts),
  --     keeping every predicate: only origin='native' flash/send ticks count;
  --     a climber with ANY non-native flash/send at the key is excluded
  --     entirely (their ascent is already inside upstream_ascensionist_count);
  --     kilter_detached_at IS NULL is applied BEFORE the per-user grouping;
  --     a native tick pushed to Kilter more than 48h before the last upstream
  --     sync is treated as absorbed into the upstream count.
  --     quality_sum/quality_count take each climber's LATEST rated native
  --     flash/send tick (max climbed_at, tie-break max id, quality 1..5), and
  --     quality_average is re-blended with the recipe whose single source of
  --     truth is blendedQualityAverageSql in
  --     packages/db/src/queries/climb-stats/quality-blend.ts.
  --     recompute.ts's boardsesh_owned branch is deliberately NOT ported: it
  --     applies to board_climbs.user_id IS NOT NULL, and _mad_members fences
  --     this migration to user_id IS NULL catalog rows, so every canonical
  --     here is non-owned by construction.
  --
  --     Keys: every (canonical, angle) key step 2 actually wrote — captured by
  --     RETURNING into _mad_written_stats_keys, INSERT and ON CONFLICT alike —
  --     plus every key that now owns a repointed tick.
  --
  --     The step-2 keys are deliberately NOT gated on tick presence. Step 2
  --     rewrote those rows' upstream half, so their Boardsesh half and blend
  --     have to be re-derived whether or not a tick survives at that key: a key
  --     with zero live ticks recomputes to boardsesh 0 / NULL and an
  --     upstream-only blend, which is the CORRECT repair, not a disturbance.
  --     Prod carries stats rows whose Boardsesh half outlived its ticks —
  --     deleteAccount cascades boardsesh_ticks (packages/db/src/schema/app/
  --     ascents.ts, onDelete: 'cascade') with no recompute anywhere on that
  --     path, and selfHealStaleClimbStats joins THROUGH a surviving tick
  --     (packages/db/src/queries/climb-stats/self-heal.ts) so it can never see
  --     them. An earlier version of this migration imported exactly those stale
  --     halves onto the canonical and then skipped the key, publishing a
  --     phantom ascent count on the surviving climb permanently.
  --
  --     The repointed-tick keys DO keep the tick-presence gate. This migration
  --     rewrote no column on those rows — it only moved a tick onto them — so a
  --     key whose only arrivals are detached ticks has nothing to re-derive,
  --     and re-blending it would rewrite quality_average from the upstream
  --     terms on a row this migration has no business touching.
  --
  --     Rows only, too: this pass never INSERTs a stats row, so a key with no
  --     stats row before the merge still has none after (recompute, not invent)
  --     and the next tick write seeds it the normal way. Offline propagation is
  --     the trigger's job as usual (trg_board_climb_stats_set_sync_fields,
  --     0144/0146) — do NOT stamp updated_at/sync_seq by hand.
  CREATE TEMP TABLE _mad_recompute_keys ON COMMIT DROP AS
    SELECT climb_uuid, angle FROM _mad_written_stats_keys
    UNION
    SELECT k.climb_uuid, k.angle
      FROM _mad_repointed_tick_keys k
     WHERE EXISTS (
       SELECT 1 FROM boardsesh_ticks bt
        WHERE bt.board_type = 'moonboard'
          AND bt.climb_uuid = k.climb_uuid
          AND bt.angle = k.angle
          AND bt.kilter_detached_at IS NULL
     );

  WITH per_user AS (
    SELECT bt.climb_uuid, bt.angle, bt.user_id,
           bool_or(
             bt.origin = 'native' AND bt.status IN ('flash','send')
             AND NOT (
               bt.kilter_id IS NOT NULL
               AND bt.kilter_synced_at IS NOT NULL
               AND s.upstream_synced_at IS NOT NULL
               AND bt.kilter_synced_at < s.upstream_synced_at - interval '48 hours'
             )
           ) AS has_unabsorbed_native_send,
           bool_or(bt.origin <> 'native' AND bt.status IN ('flash','send')) AS has_upstream
      FROM boardsesh_ticks bt
      JOIN _mad_recompute_keys k ON k.climb_uuid = bt.climb_uuid AND k.angle = bt.angle
      JOIN board_climb_stats s
        ON s.board_type = 'moonboard' AND s.climb_uuid = bt.climb_uuid AND s.angle = bt.angle
     WHERE bt.board_type = 'moonboard'
       AND bt.kilter_detached_at IS NULL
     GROUP BY bt.climb_uuid, bt.angle, bt.user_id
  ),
  counts AS (
    SELECT climb_uuid, angle,
           COUNT(*) FILTER (WHERE has_unabsorbed_native_send AND NOT has_upstream) AS distinct_senders
      FROM per_user
     GROUP BY climb_uuid, angle
  ),
  bs_quality AS (
    SELECT latest.climb_uuid, latest.angle,
           SUM(latest.quality)::double precision AS bs_quality_sum,
           COUNT(*)::bigint AS bs_quality_count
      FROM (
        SELECT DISTINCT ON (bt.climb_uuid, bt.angle, bt.user_id)
               bt.climb_uuid, bt.angle, bt.quality
          FROM boardsesh_ticks bt
          JOIN _mad_recompute_keys k ON k.climb_uuid = bt.climb_uuid AND k.angle = bt.angle
         WHERE bt.board_type = 'moonboard'
           AND bt.origin = 'native'
           AND bt.status IN ('flash','send')
           AND bt.quality IS NOT NULL
           AND bt.quality >= 1
           AND bt.quality <= 5
           AND bt.kilter_detached_at IS NULL
         ORDER BY bt.climb_uuid, bt.angle, bt.user_id, bt.climbed_at DESC, bt.id DESC
      ) latest
     GROUP BY latest.climb_uuid, latest.angle
  )
  UPDATE board_climb_stats s
     SET boardsesh_ascensionist_count = COALESCE(c.distinct_senders, 0),
         -- The materialized invariant, rewritten in the same statement that
         -- moves its Boardsesh term (see boardClimbStats in
         -- packages/db/src/schema/boards/unified.ts).
         ascensionist_count = COALESCE(s.upstream_ascensionist_count, 0) + COALESCE(c.distinct_senders, 0),
         boardsesh_quality_sum = bq.bs_quality_sum,
         boardsesh_quality_count = NULLIF(bq.bs_quality_count, 0),
         -- blendedQualityAverageSql (quality-blend.ts) inlined verbatim. The
         -- Boardsesh terms MUST come from the CTE, not from the columns being
         -- SET above: an UPDATE's SET expressions still see the OLD values.
         quality_average = COALESCE(
           (
             (COALESCE(s.upstream_quality_average * s.upstream_ascensionist_count, 0) + COALESCE(bq.bs_quality_sum, 0))
             / NULLIF(
                 COALESCE(CASE WHEN s.upstream_quality_average IS NOT NULL THEN s.upstream_ascensionist_count END, 0)
                 + COALESCE(bq.bs_quality_count, 0),
                 0
               )
           ),
           s.upstream_quality_average
         )
    FROM _mad_recompute_keys k
    LEFT JOIN counts c ON c.climb_uuid = k.climb_uuid AND c.angle = k.angle
    LEFT JOIN bs_quality bq ON bq.climb_uuid = k.climb_uuid AND bq.angle = k.angle
   WHERE s.board_type = 'moonboard' AND s.climb_uuid = k.climb_uuid AND s.angle = k.angle;

  -- 4. Repoints where a real collision is possible because the post-repoint
  --    unique key can already be taken. Every one of these ranks ALL rows
  --    touching the group — the canonical's own pre-existing row (if any)
  --    PLUS every alias member's row, via _mad_all_ids — per post-repoint key
  --    and keeps exactly one. It is NOT just "does it collide with the
  --    canonical": two DIFFERENT non-canonical members can collide with EACH
  --    OTHER once both repoint onto the same canonical, which a
  --    canonical-only check misses entirely (reproduced against a scratch DB
  --    with a 3-member group: two losing members both playlisted, migration
  --    aborted with a unique-constraint violation).
  --
  --    SURVIVOR POLICY. Which row survives is a product decision, not an
  --    implementation detail — a user opens the app after this migration and
  --    sees whichever row we kept. Each table below states its policy on its
  --    own ORDER BY so a single table can be re-argued without touching the
  --    others:
  --      votes                  -> the user's LATEST vote (their current opinion)
  --      user_favorites         -> the EARLIEST row ("when I first added it")
  --      playlist_climbs        -> the EARLIEST row (same reasoning + its slot)
  --      board_circuits_climbs  -> the EARLIEST row (lowest position)
  --      climb_classic_status   -> canonical's own, else the strongest signal
  --      climb_community_status -> canonical's own, else the strongest signal
  --      board_beta_links       -> canonical's own, else the strongest signal
  --      board_climb_ratings    -> canonical's own, else lowest id (no MoonBoard
  --                                row can exist — see 5b)
  --    Every ORDER BY ends in a unique column (id / ctid) so the outcome is
  --    deterministic on ties, not left to physical row order.
  --
  --    OFFLINE CLIENTS. user_favorites and playlist_climbs are the only two
  --    tables here that offline clients hold (packages/shared/offline-sync/
  --    src/sync/table-config.ts), and both are keyed LOCALLY by climb_uuid —
  --    user_favorites by (board_name, climb_uuid, angle), playlist_climbs by
  --    (playlist_uuid, climb_uuid). A repoint therefore MOVES a row's client
  --    primary key, and an UPDATE fires no delete trigger, so without help the
  --    device keeps the old-key row forever alongside the new one. Two things
  --    handle that below: the DELETEs emit tombstones through the live
  --    triggers (trg_favorites_delete / trg_playlist_climbs_delete, 0144/0146
  --    — this migration must NOT set boardsesh.suppress_sync_tombstones), and
  --    the surviving-but-moved rows get a hand-written sync_deletions row for
  --    the key they vacated. For those two tables the survivor is additionally
  --    pinned to the canonical's OWN physical row whenever one exists, with
  --    the policy winner's values copied onto it: that keeps every tombstone
  --    naming a key nothing re-occupies, so a tombstone can never race ahead
  --    of the upsert that would restore the row (pull-client applies deletions
  --    before table pulls, but the two ride independent cursors).
  --    board_circuits_climbs, climb_classic_status, climb_community_status,
  --    board_beta_links, votes, vote_counts and board_climb_ratings are not in
  --    any sync table config and have no delete trigger, so they need neither.

  -- playlist_climbs. Policy: EARLIEST added_at wins, and the surviving row
  -- keeps the earliest position so the climb holds its slot in the list.
  CREATE TEMP TABLE _mad_playlist_plan ON COMMIT DROP AS
    SELECT pc.id, pc.playlist_id, pc.climb_uuid AS old_climb_uuid, ids.canonical_uuid,
           MIN(pc.added_at) OVER w AS winner_added_at,
           MIN(pc.position) OVER w AS winner_position,
           ROW_NUMBER() OVER (
             PARTITION BY pc.playlist_id, ids.canonical_uuid
             ORDER BY (pc.climb_uuid = ids.canonical_uuid) DESC,
                      pc.added_at ASC, pc.position ASC, pc.id ASC
           ) AS keep_rank
      FROM playlist_climbs pc
      JOIN _mad_all_ids ids ON ids.uuid = pc.climb_uuid
    WINDOW w AS (PARTITION BY pc.playlist_id, ids.canonical_uuid);

  DELETE FROM playlist_climbs pc USING _mad_playlist_plan p
   WHERE pc.id = p.id AND p.keep_rank > 1;

  -- Tombstone the key each surviving-but-moved row vacates. Mirrors
  -- log_deletion_playlist_climbs() (0146) exactly: record_id is
  -- '<playlist uuid>:<climb uuid>' — the playlist's UUID, not its id — scoped
  -- to the playlist OWNER, and both of the trigger's guards (playlist gone /
  -- no owner row) are reproduced as inner joins so a hand-written tombstone
  -- can never be broader than the trigger's own.
  INSERT INTO sync_deletions (table_name, record_id, user_id)
  SELECT 'playlist_climbs', pl.uuid || ':' || p.old_climb_uuid, po.user_id
    FROM _mad_playlist_plan p
    JOIN playlists pl ON pl.id = p.playlist_id
    JOIN LATERAL (
      SELECT o.user_id FROM playlist_ownership o
       WHERE o.playlist_id = p.playlist_id AND o.role = 'owner'
       LIMIT 1
    ) po ON true
   WHERE p.keep_rank = 1 AND p.old_climb_uuid <> p.canonical_uuid;

  UPDATE playlist_climbs pc
     SET climb_uuid = p.canonical_uuid,
         added_at = p.winner_added_at,
         position = p.winner_position
    FROM _mad_playlist_plan p
   WHERE pc.id = p.id AND p.keep_rank = 1
     AND (pc.climb_uuid IS DISTINCT FROM p.canonical_uuid
          OR pc.added_at IS DISTINCT FROM p.winner_added_at
          OR pc.position IS DISTINCT FROM p.winner_position);

  -- board_circuits_climbs. Policy: EARLIEST row = lowest position (the table
  -- has no timestamp at all). A collision can leave a gap in the circuit's
  -- position sequence — accepted: position only drives ORDER BY for circuit
  -- member display, which doesn't need contiguity. No surrogate id on this
  -- table; ctid is a safe same-statement tiebreak.
  WITH ranked AS (
    SELECT cc.ctid,
           ROW_NUMBER() OVER (
             PARTITION BY cc.circuit_uuid, ids.canonical_uuid
             ORDER BY cc.position ASC NULLS LAST, cc.ctid ASC
           ) AS keep_rank
      FROM board_circuits_climbs cc
      JOIN _mad_all_ids ids ON ids.uuid = cc.climb_uuid
     WHERE cc.board_type = 'moonboard'
  )
  DELETE FROM board_circuits_climbs cc USING ranked r
   WHERE cc.ctid = r.ctid AND r.keep_rank > 1;
  UPDATE board_circuits_climbs cc SET climb_uuid = m.canonical_uuid
    FROM _mad_map m WHERE cc.board_type = 'moonboard' AND cc.climb_uuid = m.alias_uuid;

  -- climb_classic_status. Policy: the canonical's own row wins; failing that,
  -- the strongest signal — a row that says the climb IS classic beats one that
  -- says it isn't (the table carries no ascent/confirmation count), then the
  -- earliest row by id.
  WITH ranked AS (
    SELECT cs.id,
           ROW_NUMBER() OVER (
             PARTITION BY ids.canonical_uuid
             ORDER BY (cs.climb_uuid = ids.canonical_uuid) DESC, cs.is_classic DESC, cs.id ASC
           ) AS keep_rank
      FROM climb_classic_status cs
      JOIN _mad_all_ids ids ON ids.uuid = cs.climb_uuid
     WHERE cs.board_type = 'moonboard'
  )
  DELETE FROM climb_classic_status cs USING ranked r
   WHERE cs.id = r.id AND r.keep_rank > 1;
  UPDATE climb_classic_status cs SET climb_uuid = m.canonical_uuid
    FROM _mad_map m WHERE cs.board_type = 'moonboard' AND cs.climb_uuid = m.alias_uuid;

  -- board_beta_links. Policy: the canonical's own row wins; failing that, the
  -- strongest signal — a beta video already tied to a specific ascent
  -- (tick_uuid IS NOT NULL) beats a loose one, then the earliest created_at
  -- (stored as text; ASC is still chronological for ISO-8601), then ctid. No
  -- surrogate id on this table either.
  WITH ranked AS (
    SELECT bl.ctid,
           ROW_NUMBER() OVER (
             PARTITION BY bl.link, ids.canonical_uuid
             ORDER BY (bl.climb_uuid = ids.canonical_uuid) DESC,
                      (bl.tick_uuid IS NOT NULL) DESC,
                      bl.created_at ASC NULLS LAST,
                      bl.ctid ASC
           ) AS keep_rank
      FROM board_beta_links bl
      JOIN _mad_all_ids ids ON ids.uuid = bl.climb_uuid
     WHERE bl.board_type = 'moonboard'
  )
  DELETE FROM board_beta_links bl USING ranked r
   WHERE bl.ctid = r.ctid AND r.keep_rank > 1;
  UPDATE board_beta_links bl SET climb_uuid = m.canonical_uuid
    FROM _mad_map m WHERE bl.board_type = 'moonboard' AND bl.climb_uuid = m.alias_uuid;

  -- 5. Angle-scoped uniqueness tables — same all-members ranking as step 4,
  --    partitioned additionally by each row's OWN angle (not the group
  --    member's "native" angle): _mad_groups guarantees distinct angles
  --    across DIFFERENT members, so a same-angle collision here would only
  --    come from a row at a non-native angle, but nothing enforces that
  --    can't happen, and the ranking handles it for free either way.

  -- user_favorites. Policy: EARLIEST created_at wins — a favourite records
  -- when the climber first starred the problem, and merging two angle-rows
  -- must not reset that. The surviving row is the canonical's own whenever it
  -- has one (see the offline-clients note in step 4), with the earliest
  -- created_at copied onto it.
  CREATE TEMP TABLE _mad_fav_plan ON COMMIT DROP AS
    SELECT uf.id, uf.user_id, uf.angle, uf.climb_uuid AS old_climb_uuid, ids.canonical_uuid,
           MIN(uf.created_at) OVER (PARTITION BY uf.user_id, ids.canonical_uuid, uf.angle) AS winner_created_at,
           ROW_NUMBER() OVER (
             PARTITION BY uf.user_id, ids.canonical_uuid, uf.angle
             ORDER BY (uf.climb_uuid = ids.canonical_uuid) DESC, uf.created_at ASC, uf.id ASC
           ) AS keep_rank
      FROM user_favorites uf
      JOIN _mad_all_ids ids ON ids.uuid = uf.climb_uuid
     WHERE uf.board_name = 'moonboard';

  DELETE FROM user_favorites uf USING _mad_fav_plan p
   WHERE uf.id = p.id AND p.keep_rank > 1;

  -- Tombstone the key each surviving-but-moved row vacates, in
  -- log_deletion_favorites()'s exact format (0144):
  -- '<board_name>:<climb uuid>:<angle>', scoped to the owning user.
  INSERT INTO sync_deletions (table_name, record_id, user_id)
  SELECT 'user_favorites', 'moonboard:' || p.old_climb_uuid || ':' || p.angle::text, p.user_id
    FROM _mad_fav_plan p
   WHERE p.keep_rank = 1 AND p.old_climb_uuid <> p.canonical_uuid;

  UPDATE user_favorites uf
     SET climb_uuid = p.canonical_uuid,
         created_at = p.winner_created_at
    FROM _mad_fav_plan p
   WHERE uf.id = p.id AND p.keep_rank = 1
     AND (uf.climb_uuid IS DISTINCT FROM p.canonical_uuid
          OR uf.created_at IS DISTINCT FROM p.winner_created_at);

  -- climb_community_status. Policy: the canonical's own row wins; failing
  -- that, the strongest signal — the most recent community decision
  -- (highest last_proposal_id, then newest updated_at), then id.
  WITH ranked AS (
    SELECT ccs.id,
           ROW_NUMBER() OVER (
             PARTITION BY ids.canonical_uuid, ccs.angle
             ORDER BY (ccs.climb_uuid = ids.canonical_uuid) DESC,
                      ccs.last_proposal_id DESC NULLS LAST,
                      ccs.updated_at DESC,
                      ccs.id ASC
           ) AS keep_rank
      FROM climb_community_status ccs
      JOIN _mad_all_ids ids ON ids.uuid = ccs.climb_uuid
     WHERE ccs.board_type = 'moonboard'
  )
  DELETE FROM climb_community_status ccs USING ranked r
   WHERE ccs.id = r.id AND r.keep_rank > 1;
  UPDATE climb_community_status ccs SET climb_uuid = m.canonical_uuid
    FROM _mad_map m WHERE ccs.board_type = 'moonboard' AND ccs.climb_uuid = m.alias_uuid;

  -- 5b. board_climb_ratings — see header: no MoonBoard row can exist today
  -- (only writer hardcodes boardType to Kilter), so this is a defensive no-op
  -- kept in case that ever changes, and its survivor policy is left at
  -- "canonical's own, else lowest id" rather than invented for dead code.
  -- Same all-members ranking, unique key (board_type, climb_uuid, angle, user_id).
  WITH ranked AS (
    SELECT bcr.id,
           ROW_NUMBER() OVER (
             PARTITION BY bcr.user_id, ids.canonical_uuid, bcr.angle
             ORDER BY (bcr.climb_uuid = ids.canonical_uuid) DESC, bcr.id ASC
           ) AS keep_rank
      FROM board_climb_ratings bcr
      JOIN _mad_all_ids ids ON ids.uuid = bcr.climb_uuid
     WHERE bcr.board_type = 'moonboard'
  )
  DELETE FROM board_climb_ratings bcr USING ranked r
   WHERE bcr.id = r.id AND r.keep_rank > 1;
  UPDATE board_climb_ratings bcr SET climb_uuid = m.canonical_uuid
    FROM _mad_map m WHERE bcr.board_type = 'moonboard' AND bcr.climb_uuid = m.alias_uuid;

  -- 5c. board_climb_grades — like 5b, a defensive no-op. MoonBoard is outside
  -- CROWD_MEAN_BOARDS (packages/db/src/queries/grade-model/constants.ts), the
  -- only board list refresh-climb-grades.ts iterates, so no MoonBoard row can
  -- exist today. It is repointed anyway because the consequences of being
  -- wrong are unusually bad here: climb_uuid is part of this table's primary
  -- key, there is no FK/cascade from board_climbs, and deleteStaleGrades is
  -- itself scoped to CROWD_MEAN_BOARDS — so an orphaned MoonBoard grade row
  -- would never be reaped by anything. Unique key (board_type, climb_uuid,
  -- angle); survivor policy left at "canonical's own, else lowest
  -- computed_at" for the same reason as 5b. NOTE: this table has no delete
  -- trigger and no tombstone stream (docs/sync-table-manifest.md), so a device
  -- that somehow already held a MoonBoard grade row would keep the stale key
  -- until its next snapshot bootstrap.
  WITH ranked AS (
    SELECT bcg.ctid,
           ROW_NUMBER() OVER (
             PARTITION BY ids.canonical_uuid, bcg.angle
             ORDER BY (bcg.climb_uuid = ids.canonical_uuid) DESC, bcg.computed_at ASC, bcg.ctid ASC
           ) AS keep_rank
      FROM board_climb_grades bcg
      JOIN _mad_all_ids ids ON ids.uuid = bcg.climb_uuid
     WHERE bcg.board_type = 'moonboard'
  )
  DELETE FROM board_climb_grades bcg USING ranked r
   WHERE bcg.ctid = r.ctid AND r.keep_rank > 1;
  UPDATE board_climb_grades bcg SET climb_uuid = m.canonical_uuid
    FROM _mad_map m WHERE bcg.board_type = 'moonboard' AND bcg.climb_uuid = m.alias_uuid;

  -- 6. votes + vote_counts. Skip the per-row trigger during the bulk repoint
  --    (same guard rebuildGymVoteCounts() uses in merge-gyms.ts) so it
  --    doesn't do wasted/premature recomputes mid-repoint, dedupe among ALL
  --    members (same ranking shape as steps 4/5 — a user could have voted on
  --    two different losing members), repoint survivors, then rebuild
  --    vote_counts from scratch for every affected canonical using the exact
  --    trigger formula/created_at chain (see header).
  PERFORM set_config('boardsesh.skip_vote_counts', 'on', true);

  -- Policy: the user's LATEST vote survives (max created_at, tie max id).
  -- A vote is an opinion, not a record of an event — if a climber upvoted the
  -- 25° row in January and downvoted the 40° row in June, June is what they
  -- think of the problem now, so keeping the older row would resurrect an
  -- opinion they already changed. This is the one table here where the
  -- canonical's own row does NOT automatically win; that is safe because
  -- votes/vote_counts are not in any offline sync table config, so no client
  -- holds a row keyed on the entity_id being vacated.
  WITH ranked AS (
    SELECT v.id,
           ROW_NUMBER() OVER (
             PARTITION BY v.user_id, ids.canonical_uuid
             ORDER BY v.created_at DESC, v.id DESC
           ) AS keep_rank
      FROM votes v
      JOIN _mad_all_ids ids ON ids.uuid = v.entity_id
     WHERE v.entity_type = 'climb'
  )
  DELETE FROM votes v USING ranked r
   WHERE v.id = r.id AND r.keep_rank > 1;
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
  -- Aliases are folded together FIRST, with the same per-column policy, for
  -- the same reason step 2 does it: a group with two alias members that both
  -- carry a row would feed one target key twice and trip "ON CONFLICT DO
  -- UPDATE command cannot affect row a second time", aborting the deploy.
  INSERT INTO board_climb_send_stats (board_type, climb_uuid, send_count_30d, sender_count_30d, send_count_90d, last_sent_at, updated_at)
  SELECT 'moonboard', m.canonical_uuid,
         SUM(s.send_count_30d)::int, MAX(s.sender_count_30d), SUM(s.send_count_90d)::int,
         MAX(s.last_sent_at), now()
    FROM board_climb_send_stats s
    JOIN _mad_map m ON m.alias_uuid = s.climb_uuid
   WHERE s.board_type = 'moonboard'
   GROUP BY m.canonical_uuid
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
  --    Offline propagation: is_listed is a SYNCED column, not a server-side
  --    filter — clients hold it and filter locally — and
  --    trg_board_climbs_set_sync_fields (0144/0146) bumps updated_at/sync_seq
  --    on any change outside its excluded set, which is what carries the flip
  --    past every device's cursor. No tombstone: the row still exists. The
  --    IS DISTINCT FROM guard keeps the trigger's WHEN clause honest — an
  --    already-false row must not be re-shipped to every client for nothing,
  --    and it makes the statement's row count the true "how many delisted".
  UPDATE board_climbs
     SET is_listed = false
   WHERE board_type = 'moonboard'
     AND is_listed IS DISTINCT FROM false
     AND uuid IN (SELECT alias_uuid FROM _mad_map);

  INSERT INTO _bs_migration_guards (tag) VALUES ('0190_moonboard_angle_dedup_backfill');

  SELECT count(*) INTO v_recomputed FROM _mad_recompute_keys;
  SELECT count(*) INTO v_tombstones FROM sync_deletions WHERE id > v_tombstone_watermark;

  RAISE NOTICE 'moonboard angle dedup: merged % non-canonical row(s) across % group(s); left % same-angle-collision group(s) untouched; recomputed % stats key(s); wrote % offline tombstone(s)',
    v_merged, v_groups, v_skipped_ambiguous, v_recomputed, v_tombstones;
END $$;
