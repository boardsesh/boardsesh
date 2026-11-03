CREATE TYPE "public"."upstream_playlist_source" AS ENUM('kilter', 'aurora');--> statement-breakpoint
CREATE TABLE "user_deleted_upstream_playlists" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"board_type" text NOT NULL,
	"upstream_source" "upstream_playlist_source" NOT NULL,
	"upstream_id" text NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_deleted_upstream_playlists" ADD CONSTRAINT "user_deleted_upstream_playlists_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_deleted_upstream_playlists_unique" ON "user_deleted_upstream_playlists" USING btree ("user_id","upstream_source","upstream_id");