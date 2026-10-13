-- Custom SQL migration file, put your code below! --
-- Clear the first ascents the tick recompute wrote onto manufacturer climbs that
-- have an owner (follow-up to #6339).
--
-- #6339's draft import stamps the importing account on an Aurora draft, so a
-- draft goes to its owner alone. Until this release the tick recompute read any
-- owner as "set in Boardsesh", so a send logged on such a climb replaced its
-- first ascent with the earliest Boardsesh sender's name. The recompute now
-- asks where the climb came from (packages/db/src/queries/climbs/
-- climb-provenance.ts) and keeps a manufacturer climb's stored first ascent, and
-- the board sync and snapshot artifacts now ship that stored credit. A name the
-- old recompute wrote would ship with it once the climb is published: a
-- Boardsesh climber's name, which stays under that climber's privacy settings
-- and never ships in either.
--
-- The rows: stats of a climb that has an owner and is a manufacturer climb
-- (written by an import, `synced`, with the manufacturer setter id), whose
-- first ascent either
--   - no upstream writer ever set (`upstream_synced_at IS NULL`: the row exists
--     only because of Boardsesh ticks, as every row of an Aurora draft does), or
--   - carries the time of a Boardsesh send at that angle, which is what the old
--     recompute stored.
-- A credit Aurora supplied is not touched, and the Aurora sync re-sends a
-- climb's stats when they change. Clearing is idempotent; a second run finds
-- nothing.
--
-- Quality and grade need no repair. The old recompute averaged the ticks in
-- place of blending them with upstream's average, and the next tick or the next
-- Aurora stats write blends them again; a grade it derived carries
-- `tick_graded_at`, which the next Aurora stats write clears.
--
-- Small by construction: before #6339 no manufacturer climb had an owner, and
-- the owner backfill has not been run. The board_climbs side is read through
-- board_climbs_user_export_idx (user_id IS NOT NULL), the stats side by primary
-- key. Each updated row moves its sync cursor (trg_board_climb_stats_set_sync_fields),
-- which re-delivers it without the name.
UPDATE board_climb_stats AS stats
   SET fa_username = NULL,
       fa_at = NULL
  FROM board_climbs AS climb
 WHERE climb.board_type = stats.board_type
   AND climb.uuid = stats.climb_uuid
   AND climb.user_id IS NOT NULL
   AND climb.synced
   AND climb.setter_id IS NOT NULL
   AND NOT climb.is_boardsesh_authored
   AND (stats.fa_username IS NOT NULL OR stats.fa_at IS NOT NULL)
   AND (
     stats.upstream_synced_at IS NULL
     OR EXISTS (
       SELECT 1
         FROM boardsesh_ticks AS send
        WHERE send.board_type = stats.board_type
          AND send.climb_uuid = stats.climb_uuid
          AND send.angle = stats.angle
          AND send.status IN ('flash', 'send')
          AND send.climbed_at = stats.fa_at
     )
   );
