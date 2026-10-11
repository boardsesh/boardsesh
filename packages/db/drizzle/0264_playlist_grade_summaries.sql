CREATE TABLE "playlist_grade_summaries" (
	"playlist_id" bigint PRIMARY KEY NOT NULL,
	"board_type" text NOT NULL,
	"graded_climb_count" integer NOT NULL,
	"min_difficulty" integer NOT NULL,
	"p10_difficulty" integer NOT NULL,
	"median_difficulty" integer NOT NULL,
	"p90_difficulty" integer NOT NULL,
	"max_difficulty" integer NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "playlist_grade_summaries" ADD CONSTRAINT "playlist_grade_summaries_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE cascade ON UPDATE no action;