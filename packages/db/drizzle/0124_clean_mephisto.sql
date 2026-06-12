ALTER TABLE "board_beta_links" ADD COLUMN "attached_by_tick_id" text;--> statement-breakpoint
CREATE INDEX "board_beta_links_attached_by_tick_idx" ON "board_beta_links" USING btree ("attached_by_tick_id") WHERE "board_beta_links"."attached_by_tick_id" IS NOT NULL;--> statement-breakpoint
-- FK is added manually because the Drizzle schema doesn't declare a references() on
-- this column (the boards/ schema avoids cross-package references to app/ascents).
-- ON DELETE SET NULL keeps the community video record when a tick is deleted.
--
-- Postgres has no `ADD CONSTRAINT IF NOT EXISTS`; use a DO block guarded
-- by pg_constraint lookup so the statement is safe to re-run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'board_beta_links_attached_by_tick_id_fkey'
      AND conrelid = '"board_beta_links"'::regclass
  ) THEN
    ALTER TABLE "board_beta_links"
      ADD CONSTRAINT "board_beta_links_attached_by_tick_id_fkey"
      FOREIGN KEY ("attached_by_tick_id") REFERENCES "boardsesh_ticks"("uuid") ON DELETE SET NULL;
  END IF;
END $$;