-- Reset the retired climb revision numbers (#6023).
--
-- The server rule that read them is gone: a tick used to count towards a
-- climb's sends, stars and "sent" marks only when its climb_revision reached
-- board_climbs.holds_revision_number, and now every tick counts. Nothing moves
-- either number any more, and saveTick stores climb_revision = NULL.
--
-- The app still makes the comparison on the phone, and reads a tick with no
-- revision as revision 1. So on a climb whose stored holds_revision_number is
-- above 1, every send logged from now on would lose its sent mark in the app
-- while the server counts it. Setting the number back to 1 makes the phone's
-- answer the server's, for every tick, without an app release.
--
-- Climb edits are believed never to have been used, in which case no row
-- matches and this is a no-op. It does not depend on that being true.
--
-- The predicate is the one of the partial index board_climbs_holds_moved_idx
-- (0253), which holds exactly these climbs, so the statement can find them
-- there and never has to scan the catalogue. Each row it changes fires
-- trg_board_climbs_set_sync_fields, which is wanted: phones are sent the row
-- again, with the reset numbers. A second run matches nothing.
--
-- A climb with revision_number above 1 and holds_revision_number at 1 (renamed
-- or regraded, holds never moved) is left alone on purpose. The rule never read
-- revision_number, on the server or on the phone, and finding those rows takes
-- a scan of the whole table.
--
-- board_climb_revisions and boardsesh_ticks are not touched.
--
-- The same statement marks every stats key of a climb it reset in
-- climb_stats_recompute_pending. Those board_climb_stats rows were last
-- written while the rule left older ticks out, and would otherwise keep those
-- counts until the key's next tick. The self-heal job drains the markers and
-- recomputes each key with every tick counted. One statement, not two: once the
-- UPDATE has run, nothing else says which climbs it touched. A key that is
-- already marked keeps its marker.
WITH reset AS (
  UPDATE "board_climbs"
  SET "revision_number" = 1,
      "holds_revision_number" = 1
  WHERE "holds_revision_number" > 1
  RETURNING "board_type", "uuid"
)
INSERT INTO "climb_stats_recompute_pending" ("board_type", "climb_uuid", "angle")
SELECT stats."board_type", stats."climb_uuid", stats."angle"
FROM reset
JOIN "board_climb_stats" AS stats
  ON stats."board_type" = reset."board_type"
 AND stats."climb_uuid" = reset."uuid"
ON CONFLICT ("board_type", "climb_uuid", "angle") DO NOTHING;
