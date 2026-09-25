CREATE TABLE "board_climb_neighbor_runs" (
	"board_type" text PRIMARY KEY NOT NULL,
	"last_sync_seq" bigint DEFAULT 0 NOT NULL,
	"computed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "board_climb_neighbors" (
	"board_type" text NOT NULL,
	"climb_uuid" text NOT NULL,
	"neighbor_uuid" text NOT NULL,
	"shared_hold_count" integer NOT NULL,
	"target_hold_count" integer NOT NULL,
	"candidate_hold_count" integer NOT NULL,
	"jaccard" real NOT NULL,
	"rank" integer NOT NULL,
	"list_size" integer NOT NULL,
	"computed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "board_climb_neighbors_board_type_climb_uuid_neighbor_uuid_pk" PRIMARY KEY("board_type","climb_uuid","neighbor_uuid")
);
--> statement-breakpoint
ALTER TABLE "board_climb_neighbors" ADD CONSTRAINT "board_climb_neighbors_climb_fk" FOREIGN KEY ("climb_uuid") REFERENCES "public"."board_climbs"("uuid") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "board_climb_neighbors" ADD CONSTRAINT "board_climb_neighbors_neighbor_fk" FOREIGN KEY ("neighbor_uuid") REFERENCES "public"."board_climbs"("uuid") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "board_climb_neighbors_rank_idx" ON "board_climb_neighbors" USING btree ("board_type","climb_uuid","rank");--> statement-breakpoint
CREATE INDEX "board_climb_neighbors_neighbor_idx" ON "board_climb_neighbors" USING btree ("board_type","neighbor_uuid");