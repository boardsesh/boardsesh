CREATE TABLE "aurora_wall_sources" (
	"source_key" text PRIMARY KEY NOT NULL,
	"source_board_uuid" text,
	"board_type" text NOT NULL,
	"gym_user_id" integer NOT NULL,
	"wall_uuid" text NOT NULL,
	"serial_number" text NOT NULL,
	"layout_id" integer NOT NULL,
	"size_id" integer NOT NULL,
	"set_ids" text NOT NULL,
	"is_listed" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "board_climb_events" ALTER COLUMN "angle" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "aurora_wall_sources" ADD CONSTRAINT "aurora_wall_sources_source_board_uuid_user_boards_uuid_fk" FOREIGN KEY ("source_board_uuid") REFERENCES "public"."user_boards"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "aurora_wall_sources_board_idx" ON "aurora_wall_sources" USING btree ("source_board_uuid");--> statement-breakpoint
CREATE INDEX "aurora_wall_sources_serial_idx" ON "aurora_wall_sources" USING btree ("board_type","serial_number");--> statement-breakpoint
CREATE INDEX "aurora_wall_sources_gym_idx" ON "aurora_wall_sources" USING btree ("board_type","gym_user_id");