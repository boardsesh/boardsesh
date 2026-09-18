CREATE TABLE "kilter_wall_sources" (
	"source_key" text PRIMARY KEY NOT NULL,
	"source_board_uuid" text NOT NULL,
	"gym_uuid" text NOT NULL,
	"product_layout_uuid" text NOT NULL,
	"wall_uuid" text NOT NULL,
	"layout_id" integer NOT NULL,
	"size_id" integer NOT NULL,
	"set_ids" text NOT NULL,
	"is_listed" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "board_climb_events" ADD COLUMN "source" text DEFAULT 'boardsesh' NOT NULL;--> statement-breakpoint
ALTER TABLE "board_climb_events" ADD COLUMN "external_occurrence_key" text;--> statement-breakpoint
ALTER TABLE "board_climb_events" ADD COLUMN "external_display_name" text;--> statement-breakpoint
ALTER TABLE "kilter_wall_sources" ADD CONSTRAINT "kilter_wall_sources_source_board_uuid_user_boards_uuid_fk" FOREIGN KEY ("source_board_uuid") REFERENCES "public"."user_boards"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kilter_wall_sources_board_idx" ON "kilter_wall_sources" USING btree ("source_board_uuid");--> statement-breakpoint
CREATE UNIQUE INDEX "board_climb_events_external_occurrence_unique" ON "board_climb_events" USING btree ("source","external_occurrence_key");--> statement-breakpoint
CREATE INDEX "board_climb_events_chronological_idx" ON "board_climb_events" USING btree ("board_id","confirmed_at","seq");