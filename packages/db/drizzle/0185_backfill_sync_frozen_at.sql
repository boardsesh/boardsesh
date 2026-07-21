-- Freeze rows a human already curated before sync_frozen_at existed.
-- Any gym/board owned by someone other than the SYSTEM import user was
-- created or claimed by a real user, so it is human-curated: mark it frozen
-- (using updated_at as the best-known curation time) so the location sync can
-- never overwrite it. Idempotent via COALESCE — re-running never moves a stamp.
UPDATE "gyms"
   SET "sync_frozen_at" = COALESCE("sync_frozen_at", "updated_at")
 WHERE "owner_id" <> '00000000-0000-0000-0000-000000000000';
--> statement-breakpoint
UPDATE "user_boards"
   SET "sync_frozen_at" = COALESCE("sync_frozen_at", "updated_at")
 WHERE "owner_id" <> '00000000-0000-0000-0000-000000000000';
