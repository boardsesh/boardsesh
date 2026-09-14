CREATE TYPE "public"."spray_hold_source" AS ENUM('manual', 'auto');--> statement-breakpoint
CREATE TYPE "public"."spray_wall_version_status" AS ENUM('draft', 'published', 'superseded');--> statement-breakpoint
CREATE SEQUENCE "public"."spray_hold_catalog_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "public"."spray_wall_catalog_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "spray_climb_lineage" (
	"child_uuid" text PRIMARY KEY NOT NULL,
	"parent_uuid" text NOT NULL,
	"wall_version_id" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spray_wall_holds" (
	"wall_id" bigint NOT NULL,
	"hold_id" integer NOT NULL,
	"cx" integer NOT NULL,
	"cy" integer NOT NULL,
	"r" integer NOT NULL,
	"outline" jsonb,
	"installed_version_id" bigint NOT NULL,
	"removed_version_id" bigint,
	"moved_from_hold_id" integer,
	"source" "spray_hold_source" DEFAULT 'manual' NOT NULL,
	"confidence" real,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "spray_wall_holds_wall_id_hold_id_pk" PRIMARY KEY("wall_id","hold_id")
);
--> statement-breakpoint
CREATE TABLE "spray_wall_versions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"wall_id" bigint NOT NULL,
	"version_number" integer NOT NULL,
	"status" "spray_wall_version_status" DEFAULT 'draft' NOT NULL,
	"photo_key" text,
	"photo_width" integer,
	"photo_height" integer,
	"anchors" jsonb,
	"homography" jsonb,
	"notes" text,
	"created_by" text,
	"published_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spray_walls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"board_uuid" text NOT NULL,
	"layout_id" integer NOT NULL,
	"reference_width" integer,
	"reference_height" integer,
	"current_version_id" bigint,
	"hold_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "spray_walls_board_uuid_unique" UNIQUE("board_uuid"),
	CONSTRAINT "spray_walls_layout_id_unique" UNIQUE("layout_id")
);
--> statement-breakpoint
ALTER TABLE "board_climbs" ADD COLUMN "missing_hold_count" integer;--> statement-breakpoint
ALTER TABLE "spray_climb_lineage" ADD CONSTRAINT "spray_climb_lineage_wall_version_id_spray_wall_versions_id_fk" FOREIGN KEY ("wall_version_id") REFERENCES "public"."spray_wall_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spray_climb_lineage" ADD CONSTRAINT "spray_climb_lineage_child_fk" FOREIGN KEY ("child_uuid") REFERENCES "public"."board_climbs"("uuid") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "spray_wall_holds" ADD CONSTRAINT "spray_wall_holds_wall_id_spray_walls_id_fk" FOREIGN KEY ("wall_id") REFERENCES "public"."spray_walls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spray_wall_holds" ADD CONSTRAINT "spray_wall_holds_installed_version_id_spray_wall_versions_id_fk" FOREIGN KEY ("installed_version_id") REFERENCES "public"."spray_wall_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spray_wall_holds" ADD CONSTRAINT "spray_wall_holds_removed_version_id_spray_wall_versions_id_fk" FOREIGN KEY ("removed_version_id") REFERENCES "public"."spray_wall_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spray_wall_versions" ADD CONSTRAINT "spray_wall_versions_wall_id_spray_walls_id_fk" FOREIGN KEY ("wall_id") REFERENCES "public"."spray_walls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spray_wall_versions" ADD CONSTRAINT "spray_wall_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spray_walls" ADD CONSTRAINT "spray_walls_board_uuid_user_boards_uuid_fk" FOREIGN KEY ("board_uuid") REFERENCES "public"."user_boards"("uuid") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spray_walls" ADD CONSTRAINT "spray_walls_current_version_id_spray_wall_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."spray_wall_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "spray_climb_lineage_parent_idx" ON "spray_climb_lineage" USING btree ("parent_uuid");--> statement-breakpoint
CREATE INDEX "spray_wall_holds_alive_idx" ON "spray_wall_holds" USING btree ("wall_id","removed_version_id");--> statement-breakpoint
CREATE INDEX "spray_wall_holds_moved_from_idx" ON "spray_wall_holds" USING btree ("moved_from_hold_id") WHERE "spray_wall_holds"."moved_from_hold_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "spray_wall_versions_wall_version_idx" ON "spray_wall_versions" USING btree ("wall_id","version_number");--> statement-breakpoint
CREATE INDEX "spray_walls_current_version_idx" ON "spray_walls" USING btree ("current_version_id");