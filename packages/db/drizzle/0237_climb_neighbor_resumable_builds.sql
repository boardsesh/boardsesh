CREATE TABLE "board_climb_neighbor_group_runs" (
	"board_type" text NOT NULL,
	"layout_id" integer NOT NULL,
	"size_id" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp NOT NULL,
	CONSTRAINT "board_climb_neighbor_group_runs_board_type_layout_id_size_id_pk" PRIMARY KEY("board_type","layout_id","size_id")
);
--> statement-breakpoint
ALTER TABLE "board_climb_neighbor_runs" ADD COLUMN "full_build_started_at" timestamp;--> statement-breakpoint
ALTER TABLE "board_climb_neighbor_runs" ADD COLUMN "full_build_sync_seq" bigint;