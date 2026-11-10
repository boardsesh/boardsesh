CREATE TABLE "logbook_change_watermark" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"feed_generation" uuid DEFAULT gen_random_uuid() NOT NULL,
	"pruned_through_txid" "xid8" DEFAULT '0'::xid8 NOT NULL,
	"pruned_through_seq" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "logbook_changes" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"txid" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	"user_id" text NOT NULL,
	"tick_uuid" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "logbook_changes_user_position_idx" ON "logbook_changes" USING btree ("user_id","txid","seq");--> statement-breakpoint
CREATE INDEX "logbook_changes_created_at_brin_idx" ON "logbook_changes" USING brin ("created_at");