ALTER TABLE "aurora_credentials" ADD COLUMN "last_sync_attempt_at" timestamp;--> statement-breakpoint
CREATE INDEX "aurora_credentials_sync_attempt_priority_idx" ON "aurora_credentials" USING btree ("board_type","sync_status","last_sync_attempt_at") WHERE "aurora_credentials"."sync_status" IN ('pending', 'active', 'error');
