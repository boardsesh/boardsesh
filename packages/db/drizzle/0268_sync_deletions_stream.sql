-- Two plain indexes on sync_deletions, built inside the deploy transaction on
-- purpose (docs/db-migrations.md, "Indexes on a large, write-hot table").
--
-- What that holds, and for how long: `migrate` applies every pending migration
-- in ONE transaction, so each lock below is held until the last of them
-- commits. ADD COLUMN takes ACCESS EXCLUSIVE on sync_deletions and each CREATE
-- INDEX scans it, so every read of the deletion log, every marker insert, and
-- so every delete on a synced table (its trigger writes a marker) waits for
-- both builds. The reference-membership migration, earlier in the same
-- transaction, created a trigger on board_climbs, whose SHARE ROW EXCLUSIVE
-- lock blocks every climb write for the same stretch.
--
-- Accepted because the table is small: the daily prune keeps 90 days of
-- markers (SYNC_DELETIONS_RETENTION_DAYS), and bulk imports write none. Check
-- `SELECT pg_size_pretty(pg_total_relation_size('sync_deletions'))` before the
-- deploy. If it is large, build both indexes CONCURRENTLY first and make these
-- CREATE INDEX IF NOT EXISTS with the same names, before this merges.
ALTER TABLE "sync_deletions" ADD COLUMN "stream_at" timestamp;--> statement-breakpoint
CREATE INDEX "sync_deletions_user_stream_idx" ON "sync_deletions" USING btree ("user_id",COALESCE("stream_at", "deleted_at"),"id");--> statement-breakpoint
CREATE INDEX "sync_deletions_null_stream_idx" ON "sync_deletions" USING btree (COALESCE("stream_at", "deleted_at"),"id") WHERE "sync_deletions"."user_id" IS NULL;