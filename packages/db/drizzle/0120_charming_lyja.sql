CREATE TABLE "session_health_kit_workouts" (
	"session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workout_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "session_health_kit_workouts_session_id_user_id_pk" PRIMARY KEY("session_id","user_id")
);
--> statement-breakpoint
DELETE FROM "notifications"
WHERE (
  "entity_type" = 'session'
  AND (
    "entity_id" IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM "board_sessions" bs WHERE bs."id" = "notifications"."entity_id"
    )
  )
)
OR (
  "entity_type" = 'comment'
  AND "entity_id" IN (
    SELECT c."uuid"
    FROM "comments" c
    WHERE c."entity_type" = 'session'
      AND NOT EXISTS (
        SELECT 1 FROM "board_sessions" bs WHERE bs."id" = c."entity_id"
      )
  )
)
OR "comment_id" IN (
  SELECT c."id"
  FROM "comments" c
  WHERE c."entity_type" = 'session'
    AND NOT EXISTS (
      SELECT 1 FROM "board_sessions" bs WHERE bs."id" = c."entity_id"
    )
);--> statement-breakpoint
DELETE FROM "feed_items"
WHERE (
  "entity_type" = 'session'
  AND NOT EXISTS (
    SELECT 1 FROM "board_sessions" bs WHERE bs."id" = "feed_items"."entity_id"
  )
)
OR (
  "entity_type" = 'comment'
  AND "entity_id" IN (
    SELECT c."uuid"
    FROM "comments" c
    WHERE c."entity_type" = 'session'
      AND NOT EXISTS (
        SELECT 1 FROM "board_sessions" bs WHERE bs."id" = c."entity_id"
      )
  )
);--> statement-breakpoint
DELETE FROM "votes"
WHERE (
  "entity_type" = 'session'
  AND NOT EXISTS (
    SELECT 1 FROM "board_sessions" bs WHERE bs."id" = "votes"."entity_id"
  )
)
OR (
  "entity_type" = 'comment'
  AND "entity_id" IN (
    SELECT c."uuid"
    FROM "comments" c
    WHERE c."entity_type" = 'session'
      AND NOT EXISTS (
        SELECT 1 FROM "board_sessions" bs WHERE bs."id" = c."entity_id"
      )
  )
);--> statement-breakpoint
DELETE FROM "vote_counts"
WHERE (
  "entity_type" = 'session'
  AND NOT EXISTS (
    SELECT 1 FROM "board_sessions" bs WHERE bs."id" = "vote_counts"."entity_id"
  )
)
OR (
  "entity_type" = 'comment'
  AND "entity_id" IN (
    SELECT c."uuid"
    FROM "comments" c
    WHERE c."entity_type" = 'session'
      AND NOT EXISTS (
        SELECT 1 FROM "board_sessions" bs WHERE bs."id" = c."entity_id"
      )
  )
);--> statement-breakpoint
DELETE FROM "comments"
WHERE "entity_type" = 'session'
  AND NOT EXISTS (
    SELECT 1 FROM "board_sessions" bs WHERE bs."id" = "comments"."entity_id"
  );--> statement-breakpoint
ALTER TABLE "boardsesh_ticks" DROP CONSTRAINT IF EXISTS "boardsesh_ticks_inferred_session_id_inferred_sessions_id_fk";--> statement-breakpoint
ALTER TABLE "boardsesh_ticks" DROP CONSTRAINT IF EXISTS "boardsesh_ticks_previous_inferred_session_id_inferred_sessions_id_fk";--> statement-breakpoint
DROP INDEX IF EXISTS "boardsesh_ticks_inferred_session_idx";--> statement-breakpoint
ALTER TABLE "session_health_kit_workouts" ADD CONSTRAINT "session_health_kit_workouts_session_id_board_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."board_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_health_kit_workouts" ADD CONSTRAINT "session_health_kit_workouts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_health_kit_workouts_session_idx" ON "session_health_kit_workouts" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "session_health_kit_workouts_user_idx" ON "session_health_kit_workouts" USING btree ("user_id");--> statement-breakpoint
INSERT INTO "session_health_kit_workouts" (
  "session_id",
  "user_id",
  "workout_id",
  "created_at",
  "updated_at"
)
SELECT
  "id",
  "created_by_user_id",
  "health_kit_workout_id",
  "created_at",
  now()
FROM "board_sessions"
WHERE "health_kit_workout_id" IS NOT NULL
  AND "created_by_user_id" IS NOT NULL
ON CONFLICT ("session_id", "user_id") DO UPDATE SET
  "workout_id" = EXCLUDED."workout_id",
  "updated_at" = now();--> statement-breakpoint
ALTER TABLE "board_sessions" DROP COLUMN IF EXISTS "health_kit_workout_id";--> statement-breakpoint
ALTER TABLE "boardsesh_ticks" DROP COLUMN IF EXISTS "inferred_session_id";--> statement-breakpoint
ALTER TABLE "boardsesh_ticks" DROP COLUMN IF EXISTS "previous_inferred_session_id";--> statement-breakpoint
ALTER TABLE IF EXISTS "inferred_sessions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE IF EXISTS "session_member_overrides" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE IF EXISTS "session_member_overrides" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "inferred_sessions" CASCADE;
