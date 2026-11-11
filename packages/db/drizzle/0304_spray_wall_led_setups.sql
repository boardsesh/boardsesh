CREATE TABLE "spray_wall_led_setups" (
	"board_id" bigint PRIMARY KEY NOT NULL,
	"controller_type" text DEFAULT 'wled' NOT NULL,
	"controller_url" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"layout" jsonb,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spray_wall_led_setups" ADD CONSTRAINT "spray_wall_led_setups_board_id_user_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."user_boards"("id") ON DELETE cascade ON UPDATE no action;