ALTER TYPE "public"."notification_type" ADD VALUE 'proposal_on_your_climb';--> statement-breakpoint
ALTER TYPE "public"."proposal_type" ADD VALUE 'hide';--> statement-breakpoint
ALTER TABLE "board_climbs" ADD COLUMN "is_hidden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "board_climbs" ADD COLUMN "hidden_at" timestamp;