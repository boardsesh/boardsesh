CREATE TABLE "board_climb_send_stats" (
	"board_type" text NOT NULL,
	"climb_uuid" text NOT NULL,
	"send_count_30d" integer DEFAULT 0 NOT NULL,
	"sender_count_30d" integer DEFAULT 0 NOT NULL,
	"send_count_90d" integer DEFAULT 0 NOT NULL,
	"last_sent_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "board_climb_send_stats_board_type_climb_uuid_pk" PRIMARY KEY("board_type","climb_uuid")
);
--> statement-breakpoint
CREATE TABLE "board_setter_stats" (
	"board_type" text NOT NULL,
	"setter_username" text NOT NULL,
	"climb_count" integer DEFAULT 0 NOT NULL,
	"total_ascents" bigint DEFAULT 0 NOT NULL,
	"avg_ascents_per_climb" double precision DEFAULT 0 NOT NULL,
	"avg_quality" double precision,
	"setter_score" double precision DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "board_setter_stats_board_type_setter_username_pk" PRIMARY KEY("board_type","setter_username")
);
--> statement-breakpoint
CREATE INDEX "board_climb_send_stats_trending_idx" ON "board_climb_send_stats" USING btree ("board_type","send_count_30d");--> statement-breakpoint
CREATE INDEX "board_setter_stats_score_idx" ON "board_setter_stats" USING btree ("board_type","setter_score");