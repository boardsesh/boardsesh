-- Tick climb revisions (#6023): each tick records which revision of the climb
-- it was logged against, and board_climbs carries its current revision and the
-- revision at which its holds last changed.
--
-- board_climbs and boardsesh_ticks are both large and write-hot. The three
-- ALTERs are metadata-only on PG18: a nullable column, and two NOT NULL columns
-- whose default is a constant, so no row is rewritten. Every existing tick stays
-- NULL (unknown).
--
-- The UPDATE at the end is a backfill for the gap between two deploys. 0251
-- (board_climb_revisions, and the code that writes it) can reach production
-- days before this migration does. Every edit made in between writes revision
-- rows, while the two new columns come up as 1 for that climb. The UPDATE sets
-- them from the rows: the newest revision number, and the newest revision whose
-- `changes` names 'holds' (1 when none does). It touches only climbs that have
-- revision rows and whose numbers differ, so it is a no-op on an empty table
-- and on a second run, and it never rewrites the catalogue. Each row it changes
-- fires trg_board_climbs_set_sync_fields, which is wanted: the phone has to be
-- sent the new numbers.
--
-- Two ways the backfilled holds epoch can be off, both narrow. `changes`
-- reports a pace-only edit as 'holds' (diffClimbRevisionStates), and the code
-- does not move the epoch for one, so a climb whose last 'holds' revision was a
-- pace change gets an epoch one edit too high. And a 'holds' revision pruned
-- past the 50-edit cap is not there to be found, which leaves the epoch too
-- low. Neither can be told apart from the rows that are left.
ALTER TABLE "board_climbs" ADD COLUMN "revision_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "board_climbs" ADD COLUMN "holds_revision_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "boardsesh_ticks" ADD COLUMN "climb_revision" integer;--> statement-breakpoint
UPDATE "board_climbs" AS climb
SET "revision_number" = recorded.revision_number,
    "holds_revision_number" = recorded.holds_revision_number
FROM (
  SELECT "board_type",
         "climb_uuid",
         max("revision_number") AS revision_number,
         COALESCE(max("revision_number") FILTER (WHERE 'holds' = ANY("changes")), 1) AS holds_revision_number
  FROM "board_climb_revisions"
  GROUP BY "board_type", "climb_uuid"
) AS recorded
WHERE climb."uuid" = recorded.climb_uuid
  AND climb."board_type" = recorded.board_type
  AND (climb."revision_number", climb."holds_revision_number")
      IS DISTINCT FROM (recorded.revision_number, recorded.holds_revision_number);
