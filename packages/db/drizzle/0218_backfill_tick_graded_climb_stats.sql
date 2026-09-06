-- Backfill the grades of stats rows that only exist because of Boardsesh ticks.
--
-- Refs #4798. Approved by maintainer 2026-09-06.
--
-- Until this migration the tick recompute wrote difficulty_average /
-- display_difficulty only for Boardsesh-OWNED climbs, so a catalog climb
-- (board_climbs.user_id IS NULL) ticked at an angle the catalog does not grade
-- got a seeded stats row whose grade stayed NULL forever. The climb then never
-- appeared under any grade at that angle. Woods is the visible case — its
-- importer ships one graded row, at the set angle — but Kilter and Tension keys
-- with no Aurora row have the same hole.
--
-- The code fix (recompute.ts) repairs a row the next time a tick lands on it.
-- This statement repairs the rows already sitting there. Measured against prod
-- on 2026-09-06: 162 candidate rows — kilter 147, tension 8, woods 3,
-- touchstone 3, grasshopper 1 — of which 88 carry at least one graded
-- flash/send tick and get a grade here. The other 74 have only ungraded ticks
-- and are left NULL: there is nothing to average.
--
-- tick_graded_at marks every repaired row as ours, so the recompute keeps it
-- current and hands it back the moment an upstream sync stamps
-- upstream_synced_at over it. Stamped `now() AT TIME ZONE 'UTC'`, not bare
-- now(): the column is compared against upstream_synced_at, which every
-- upstream writer stores as a JS ISO string (UTC wall time), and both are
-- zoneless `timestamp` columns — a bare now() would write the session's local
-- wall time and make that comparison wrong off UTC.
--
-- MoonBoard is fenced out, matching deriveGradeFromTicksSql. Ungraded MoonBoard
-- catalog rows are legitimate and two scripts fill them from the Moon catalog
-- under a `display_difficulty IS NULL` guard (moonboard-grade-repair.ts,
-- repair-moonboard-8c-grades.ts); a tick-derived grade would make both skip the
-- row forever and would flip statsRowCarriesRealCatalogData TRUE on a row that
-- carries no catalog data. None of the 162 measured candidates were MoonBoard,
-- so the fence moves no counts here — it is present so this statement and the
-- recompute can never disagree about which rows are ours.
--
-- Deliberately skipped: a key whose only graded flash/send tick was imported
-- (origin <> 'native') has boardsesh_ascensionist_count = 0 — that climber is
-- already inside the upstream count — so it is not a candidate here. Nothing is
-- lost: the row heals on its next native tick, when the recompute runs on it.
--
-- Cost. The candidate CTE is a sequential scan of board_climb_stats: there is
-- no index on display_difficulty or boardsesh_ascensionist_count, and adding one
-- for a single one-time pass is not worth the write amplification. It is a plain
-- SELECT under AccessShareLock, so it blocks nothing; expect tens of seconds.
-- Each of the ~162 candidates then costs one index probe into boardsesh_ticks
-- (boardsesh_ticks_climb_idx) rather than a GROUP BY over the whole ticks table,
-- and the UPDATE writes ~88 rows.

WITH candidate AS (
  SELECT s.board_type, s.climb_uuid, s.angle
    FROM board_climb_stats s
    JOIN board_climbs bc
      ON bc.board_type = s.board_type
     AND bc.uuid       = s.climb_uuid
   WHERE bc.user_id IS NULL
     AND s.board_type <> 'moonboard'
     AND s.display_difficulty IS NULL
     AND COALESCE(s.boardsesh_ascensionist_count, 0) > 0
),
tick_grade AS (
  SELECT c.board_type, c.climb_uuid, c.angle,
         (SELECT AVG(t.difficulty) FILTER (WHERE t.difficulty > 1)
            FROM boardsesh_ticks t
           WHERE t.board_type = c.board_type
             AND t.climb_uuid = c.climb_uuid
             AND t.angle      = c.angle
             AND t.status IN ('flash','send')
             AND t.kilter_detached_at IS NULL) AS avg_difficulty
    FROM candidate c
)
UPDATE board_climb_stats s
   SET display_difficulty = g.avg_difficulty,
       difficulty_average = g.avg_difficulty,
       tick_graded_at     = (now() AT TIME ZONE 'UTC')
  FROM tick_grade g
 WHERE s.board_type = g.board_type
   AND s.climb_uuid = g.climb_uuid
   AND s.angle      = g.angle
   AND g.avg_difficulty IS NOT NULL;
