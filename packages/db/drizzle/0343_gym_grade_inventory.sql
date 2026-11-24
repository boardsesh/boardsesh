CREATE SEQUENCE "public"."spray_exposure_event_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "gym_board_grade_collections" (
	"board_id" bigint PRIMARY KEY NOT NULL,
	"playlist_id" bigint
);
--> statement-breakpoint
CREATE TABLE "spray_exposure_checkpoints" (
	"board_id" bigint NOT NULL,
	"board_uuid" text NOT NULL,
	"gym_id" bigint NOT NULL,
	"wall_id" bigint NOT NULL,
	"version_id" bigint NOT NULL,
	"layout_id" integer NOT NULL,
	"angle" integer NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "spray_exposure_checkpoint_binding_pk" PRIMARY KEY("board_id","board_uuid","gym_id","wall_id","version_id","layout_id","angle")
);
--> statement-breakpoint
CREATE TABLE "spray_exposure_invalidations" (
	"seq" bigint PRIMARY KEY DEFAULT nextval('public.spray_exposure_event_seq') NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spray_exposure_observations" (
	"board_id" bigint NOT NULL,
	"board_uuid" text NOT NULL,
	"gym_id" bigint NOT NULL,
	"wall_id" bigint NOT NULL,
	"version_id" bigint NOT NULL,
	"layout_id" integer NOT NULL,
	"angle" integer NOT NULL,
	"seq" bigint PRIMARY KEY DEFAULT nextval('public.spray_exposure_event_seq') NOT NULL,
	"climb_uuid" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gym_board_grade_collections" ADD CONSTRAINT "gym_board_grade_collections_board_id_user_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."user_boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_board_grade_collections" ADD CONSTRAINT "gym_board_grade_collections_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "spray_exposure_invalidation_key_idx" ON "spray_exposure_invalidations" USING btree ("kind","key","seq");--> statement-breakpoint
CREATE INDEX "spray_exposure_observation_variant_idx" ON "spray_exposure_observations" USING btree ("board_id","wall_id","layout_id","climb_uuid","angle","seq");