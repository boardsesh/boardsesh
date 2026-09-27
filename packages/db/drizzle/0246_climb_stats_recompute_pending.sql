CREATE TABLE "climb_stats_recompute_pending" (
	"board_type" text NOT NULL,
	"climb_uuid" text NOT NULL,
	"angle" integer NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "climb_stats_recompute_pending_board_type_climb_uuid_angle_pk" PRIMARY KEY("board_type","climb_uuid","angle")
);
--> statement-breakpoint
CREATE INDEX "climb_stats_recompute_pending_requested_at_idx" ON "climb_stats_recompute_pending" USING btree ("requested_at");