-- Custom SQL migration file, put your code below! --
--
-- ############################################################################
-- # PROD DATA REPAIR — rewrites real climbers' tick rows and deletes prod     #
-- # stats rows. Needs explicit maintainer sign-off before this PR merges.     #
-- ############################################################################
--
-- MoonBoard wrong-angle stats rows (#3529).
--
-- MoonBoard identity is angle-bearing: the catalog importer mints one
-- board_climbs row per (problem, angle) as uuidv5('moonboard:{id}:{angle}'),
-- each with a non-null board_climbs.angle. A tick logged while the climber's
-- board config sat at the OTHER angle therefore names a climb the catalog does
-- not grade at that angle, and the stats recompute then seeded a row there. That
-- phantom row surfaces in the wrong angle's stats-driven search with a NULL
-- grade and a 1-ascent count (search-climbs.ts INNER JOINs board_climb_stats at
-- the requested angle), while the send is missing from the page every other
-- climber browses.
--
-- The code half of the fix (resolveMoonBoardTickAngle + the recompute seed
-- guard) stops new ones. This migration repairs the rows already in prod.
--
-- PROD PREFLIGHT (2026-07-31, read-only, same day as this file):
--   * 100 MoonBoard board_climb_stats rows sit at an angle their climb is not
--     graded at. (The 2026-07 audit that filed #3529 counted 42 — it has grown,
--     which is why the numbers were re-taken rather than copied from the issue.)
--   * 0 of those 100 carry real catalog data, and 0 belong to a user-created
--     climb — so statement B deletes all 100 and the two fences below fence
--     nothing off today. They are there because they must hold on the day the
--     migration actually runs, not on the day it was written.
--   * Statement A moves 113 ticks, across 99 climbs, belonging to 10 climbers.
--   * 0 MoonBoard ticks at a wrong angle sit on a user-created climb, so the
--     bc.user_id IS NULL fence changes no row today.
--   * 101 MoonBoard stats rows have quality_normalized <> TRUE (statement C).
--   * 0 board_climb_grades rows sit at a wrong MoonBoard angle — the nightly
--     grade pipeline minted nothing at the phantom keys, so there is no fourth
--     statement to write and no follow-up to file.
--
-- WHAT IS AND IS NOT TOUCHED
--   * CATALOG CLIMBS ONLY (bc.user_id IS NULL). editClimb deliberately leaves a
--     stats row behind at the old angle when a user edits their own climb's
--     angle (resolvers/climbs/mutations.ts: "removing it would race with
--     concurrent ticks"), and that leftover row carries fa_username =
--     setterUsername. Without this fence statement A would quietly move those
--     climbers' ticks. Same precedent as 0173.
--   * Statements A and B share ONE fence, verbatim: "does this stats row carry
--     real catalog data?" — a non-zero upstream_ascensionist_count, a
--     display_difficulty, a benchmark_difficulty or an upstream_quality_average.
--     Nothing in Boardsesh can invent any of those (the tick recompute never
--     writes them), so a row with all four absent is provably a tick artefact.
--     The fences MUST stay identical: if A emptied a row that B then declined to
--     delete, the row would keep a stale non-zero boardsesh_ascensionist_count
--     with no tick anywhere to re-derive it — selfHealStaleClimbStats joins
--     ticks to stats on EQUAL angle, so it would never revisit it. The same
--     predicate lives in TypeScript at
--     packages/db/src/queries/climb-stats/real-catalog-data.ts; keep all three
--     copies in step.
--   * fa_username is deliberately NOT a catalog-data signal on MoonBoard: 0173
--     established that MoonBoard catalog FA is not authoritative, and the one
--     case where fa_username DOES mean something — a setter's own climb — is
--     already covered by the bc.user_id IS NULL fence above. On a catalog climb
--     an fa_username-only stats row is therefore deletable by statement B. Note
--     the 2026-07-31 preflight measured "carries real catalog data", which does
--     NOT cover fa_username — see the UNMEASURED block below.
--   * DUPLICATE TICKS ARE POSSIBLE (statement A). boardsesh_ticks has no unique
--     constraint on (user_id, board_type, climb_uuid, angle) — only uuid,
--     aurora_id and kilter_id are unique — so a climber who ticked the same
--     problem BOTH correctly at 40 and stranded at 25 ends up with two send rows
--     at 40. board_climb_stats.ascensionist_count stays correct (the recompute
--     counts DISTINCT climbers), so this is cosmetic in stats but visible in
--     that climber's logbook. See the UNMEASURED block below.
--
-- UNMEASURED — TAKE THESE TWO READINGS AS PART OF SIGN-OFF
--   Neither number was taken when this file was written, and neither is implied
--   by the 2026-07-31 preflight above. Both are read-only.
--
--   1. Duplicate-tick collisions. If non-zero, decide deliberately between
--      moving and deleting the loser rather than letting statement A run blind:
--
--      SELECT count(*) FROM boardsesh_ticks bt JOIN board_climbs bc
--        ON bc.uuid = bt.climb_uuid AND bc.board_type = bt.board_type
--       WHERE bt.board_type = 'moonboard' AND bc.user_id IS NULL
--         AND bc.angle IS NOT NULL AND bt.angle <> bc.angle
--         AND EXISTS (SELECT 1 FROM boardsesh_ticks o
--                      WHERE o.user_id = bt.user_id AND o.board_type = bt.board_type
--                        AND o.climb_uuid = bt.climb_uuid AND o.angle = bc.angle);
--
--   2. fa_username-carrying catalog rows at a wrong angle — the rows statement B
--      will delete that a reader might expect protected:
--
--      SELECT count(*) FROM board_climb_stats s JOIN board_climbs bc
--        ON bc.uuid = s.climb_uuid AND bc.board_type = s.board_type
--       WHERE s.board_type = 'moonboard' AND bc.user_id IS NULL
--         AND bc.angle IS NOT NULL AND s.angle <> bc.angle
--         AND s.fa_username IS NOT NULL;
--
-- WHY DELETE RATHER THAN MERGE THE COUNTS (statement B)
--   After statement A there are zero ticks left at the phantom key, so the row's
--   Boardsesh counts are provably stale artefacts of the ticks A just moved, not
--   data. Hand-adding them into the canonical row would re-implement the
--   distinct-climber counting rule (absorption guard, upstream-represented
--   guard) in SQL — exactly the duplication recomputeClimbStats exists to
--   prevent. The count is instead re-derived from the moved ticks by the
--   ordinary recompute. Deletes propagate to offline clients on their next pull:
--   trg_board_climb_stats_delete -> log_deletion_board_climb_stats writes a
--   sync_deletions tombstone (0144), so no device is left holding a ghost row.
--   board_climb_stats has no inbound FKs, and board_climb_stats_history is
--   append-only audit — left alone deliberately.
--
-- NO MANUAL TIMESTAMP STAMPING, anywhere:
--   * boardsesh_ticks.updated_at is stamped by trg_boardsesh_ticks_set_updated_at
--     (0146). `angle` is not in that trigger's ignore list, so statement A's rows
--     get a fresh updated_at automatically — which is what makes
--     selfHealStaleClimbStats (3h lookback, hourly and on daemon restart; a
--     deploy restarts the daemon) re-derive each canonical-angle row from the
--     moved ticks. If the daemon is down for more than 3h after deploy the moved
--     ticks age out of that window and the canonical counts stay stale until
--     someone re-ticks; the backstop is a one-shot recompute over the affected
--     keys.
--   * board_climb_stats.updated_at / sync_seq are owned by
--     trg_board_climb_stats_set_sync_fields (0144/0146).
--
-- IDEMPOTENT BY PREDICATE, no guard row needed: after one pass statement A's
-- `bt.angle <> bc.angle` and statement B's NOT EXISTS(tick) both stop matching,
-- and statement C's `IS DISTINCT FROM TRUE` is self-limiting. The heavier
-- _bs_migration_guards pattern (0163/0165) exists for multi-step merges that are
-- not self-idempotent; this one does not need it.

-- Statement A — move the stranded ticks to the angle their climb is graded at,
-- so the send lands on the row every surface already reads.
UPDATE boardsesh_ticks bt
   SET angle = bc.angle
  FROM board_climbs bc
 WHERE bt.board_type = 'moonboard'
   AND bc.board_type = 'moonboard'
   AND bc.uuid       = bt.climb_uuid
   AND bc.user_id IS NULL
   AND bc.angle IS NOT NULL
   AND bt.angle <> bc.angle
   AND NOT EXISTS (
     SELECT 1
       FROM board_climb_stats s
      WHERE s.board_type = 'moonboard'
        AND s.climb_uuid = bt.climb_uuid
        AND s.angle      = bt.angle
        AND (COALESCE(s.upstream_ascensionist_count, 0) > 0
             OR s.display_difficulty       IS NOT NULL
             OR s.benchmark_difficulty     IS NOT NULL
             OR s.upstream_quality_average IS NOT NULL)
   );
--> statement-breakpoint

-- Statement B — delete the phantom stats rows statement A just emptied. Same
-- fence as A, negated: a row carrying real catalog data survives, and a row that
-- still has a tick at its angle survives.
DELETE FROM board_climb_stats s
 USING board_climbs bc
 WHERE s.board_type = 'moonboard'
   AND bc.board_type = 'moonboard'
   AND bc.uuid       = s.climb_uuid
   AND bc.user_id IS NULL
   AND bc.angle IS NOT NULL
   AND s.angle <> bc.angle
   AND NOT (COALESCE(s.upstream_ascensionist_count, 0) > 0
            OR s.display_difficulty       IS NOT NULL
            OR s.benchmark_difficulty     IS NOT NULL
            OR s.upstream_quality_average IS NOT NULL)
   AND NOT EXISTS (
     SELECT 1
       FROM boardsesh_ticks bt
      WHERE bt.board_type = 'moonboard'
        AND bt.climb_uuid = s.climb_uuid
        AND bt.angle      = s.angle
   );
--> statement-breakpoint

-- Statement C — close the "every MoonBoard row is on the canonical 1-5 quality
-- scale" invariant. The forward leak was fixed in code (#3959 made the recompute
-- seed quality_normalized = TRUE) but no backfill ever ran for the rows already
-- written at the column default FALSE. Safe because every MoonBoard writer sets
-- TRUE on insert AND on conflict (import-moonboard-catalog.ts,
-- import-moonboard-2024.ts, import-moonboard-problems.ts) and the recompute's
-- Boardsesh side is built from native ticks validated 1-5, so no MoonBoard row
-- can ever hold a 1-3 value. Most of the 101 disappear with statement B; C
-- sweeps the ones sitting at a correct angle.
UPDATE board_climb_stats
   SET quality_normalized = TRUE
 WHERE board_type = 'moonboard'
   AND quality_normalized IS DISTINCT FROM TRUE;
