CREATE TABLE "board_climb_revisions" (
	"board_type" text NOT NULL,
	"climb_uuid" text NOT NULL,
	"revision_number" integer NOT NULL,
	"name" text,
	"description" text,
	"frames" text,
	"frames_count" integer,
	"frames_pace" integer,
	"angle" integer,
	"characteristics" text[],
	"difficulty_id" integer,
	"spray_wall_version_id" bigint,
	"changes" text[] DEFAULT '{}'::text[] NOT NULL,
	"edited_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_climb_revisions_climb_uuid_board_type_revision_number_pk" PRIMARY KEY("climb_uuid","board_type","revision_number")
);
--> statement-breakpoint
ALTER TABLE "board_climb_revisions" ADD CONSTRAINT "board_climb_revisions_spray_wall_version_id_spray_wall_versions_id_fk" FOREIGN KEY ("spray_wall_version_id") REFERENCES "public"."spray_wall_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_climb_revisions" ADD CONSTRAINT "board_climb_revisions_edited_by_users_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_climb_revisions" ADD CONSTRAINT "board_climb_revisions_climb_fk" FOREIGN KEY ("climb_uuid") REFERENCES "public"."board_climbs"("uuid") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "board_climb_revisions_spray_wall_version_idx" ON "board_climb_revisions" USING btree ("spray_wall_version_id") WHERE "board_climb_revisions"."spray_wall_version_id" IS NOT NULL;