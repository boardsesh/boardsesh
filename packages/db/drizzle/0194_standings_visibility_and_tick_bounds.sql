CREATE TYPE "public"."leaderboard_visibility" AS ENUM('public', 'anonymous', 'off');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_internal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "leaderboard_visibility" "leaderboard_visibility" DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "gym_screen_visibility" "leaderboard_visibility" DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_boards" ADD COLUMN "is_virtual" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "boardsesh_ticks_flash_send_climbed_at_idx" ON "boardsesh_ticks" USING btree ("climbed_at") WHERE "boardsesh_ticks"."status" IN ('flash','send');--> statement-breakpoint
--
-- Mark the system-owned "<X> Board Shared Feed" catch-all rows. These collect
-- ticks for a board config nobody has claimed a wall for; they are not walls.
-- Verified against production: this predicate matches exactly 39 rows, and no
-- Shared Feed row carries a gym_id, so the gym_id clause only guards the case
-- where one is attached later.
UPDATE "user_boards" SET "is_virtual" = true
  WHERE "name" LIKE '%Shared Feed%' AND "gym_id" IS NULL;--> statement-breakpoint
--
-- ADDED NOT VALID DELIBERATELY — do not "fix" this to a plain CHECK.
--
-- The constraint is fully enforced for every INSERT and UPDATE from here on,
-- which is the whole point: `difficulty` was unbounded in zod and in the DB, so
-- one row could carry INT_MAX and own any surface reading MAX(difficulty).
--
-- NOT VALID skips the scan of the 421k existing rows, for two reasons:
--   1. Two legacy production rows (ids 93195 and 238792, both native Kilter
--      sends from April 2026) carry difficulty = 0, which is not a grade — the
--      scale starts at 1. A plain CHECK would fail the migration outright.
--   2. Even without them, validating in-line takes an ACCESS EXCLUSIVE lock for
--      the length of a full-table scan.
-- Nulling those two rows means "use the consensus grade" per
-- docs/ascents-and-attempts.md, but it rewrites climber-entered data, so it is
-- left for an explicit call rather than smuggled into a schema migration. Once
-- they are cleared, `VALIDATE CONSTRAINT` takes only a SHARE UPDATE EXCLUSIVE
-- lock and can run against a live table.
ALTER TABLE "boardsesh_ticks" ADD CONSTRAINT "boardsesh_ticks_difficulty_range" CHECK ("boardsesh_ticks"."difficulty" IS NULL OR ("boardsesh_ticks"."difficulty" >= 1 AND "boardsesh_ticks"."difficulty" <= 39)) NOT VALID;