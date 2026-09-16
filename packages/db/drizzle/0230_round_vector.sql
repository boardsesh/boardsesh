ALTER TABLE "board_climb_ingest_skips" ADD COLUMN "rejected_at" timestamp;--> statement-breakpoint
ALTER TABLE "board_climb_ingest_skips" ADD COLUMN "rejected_reason" text;