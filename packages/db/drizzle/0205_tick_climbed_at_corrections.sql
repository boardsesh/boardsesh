CREATE TABLE "tick_climbed_at_corrections" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"tick_uuid" text NOT NULL,
	"user_id" text NOT NULL,
	"board_type" text NOT NULL,
	"origin" text NOT NULL,
	"previous_climbed_at" timestamp NOT NULL,
	"corrected_climbed_at" timestamp NOT NULL,
	"offset_seconds" integer NOT NULL,
	"anchor_key_count" integer NOT NULL,
	"anchor_trust" text NOT NULL,
	"evidence" text NOT NULL,
	"reverted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "tick_climbed_at_corrections_run_idx" ON "tick_climbed_at_corrections" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tick_climbed_at_corrections_run_tick_unique" ON "tick_climbed_at_corrections" USING btree ("run_id","tick_uuid");--> statement-breakpoint
CREATE INDEX "tick_climbed_at_corrections_tick_history_idx" ON "tick_climbed_at_corrections" USING btree ("tick_uuid","created_at");