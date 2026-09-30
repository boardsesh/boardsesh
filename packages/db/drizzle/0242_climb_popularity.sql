CREATE TABLE "board_climb_popularity" (
	"board_type" text NOT NULL,
	"climb_uuid" text NOT NULL,
	"angle" integer NOT NULL,
	"total_ascensionist_count" bigint NOT NULL,
	"display_difficulty" double precision,
	"ascensionist_count" bigint,
	CONSTRAINT "board_climb_popularity_board_type_climb_uuid_angle_pk" PRIMARY KEY("board_type","climb_uuid","angle")
);
--> statement-breakpoint
CREATE TABLE "board_climb_popularity_runs" (
	"board_type" text PRIMARY KEY NOT NULL,
	"stats_updated_through" timestamp,
	"full_built_at" timestamp,
	"refreshed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "board_climb_popularity_rank_idx" ON "board_climb_popularity" USING btree ("board_type","angle","total_ascensionist_count" DESC NULLS FIRST,"climb_uuid" DESC NULLS FIRST,"display_difficulty","ascensionist_count");