CREATE TABLE "gym_climb_comment_attributions" (
	"comment_id" bigint PRIMARY KEY NOT NULL,
	"logical_board_id" bigint NOT NULL,
	"board_uuid" text NOT NULL,
	"gym_id" bigint NOT NULL,
	"board_type" text NOT NULL,
	"climb_uuid" text NOT NULL,
	"angle" integer NOT NULL,
	"is_mirror" boolean NOT NULL,
	"comment_created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gym_reporting_tick_votes" (
	"tick_id" bigint NOT NULL,
	"metric" text NOT NULL,
	"attested_value" integer NOT NULL,
	CONSTRAINT "gym_reporting_tick_votes_tick_id_metric_pk" PRIMARY KEY("tick_id","metric"),
	CONSTRAINT "gym_reporting_tick_votes_value_check" CHECK (
      ("gym_reporting_tick_votes"."metric" = 'QUALITY' AND "gym_reporting_tick_votes"."attested_value" BETWEEN 1 AND 5)
      OR ("gym_reporting_tick_votes"."metric" = 'DIFFICULTY' AND "gym_reporting_tick_votes"."attested_value" BETWEEN 0 AND 100)
    )
);
--> statement-breakpoint
ALTER TABLE "gym_climb_comment_attributions" ADD CONSTRAINT "gym_climb_comment_attributions_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_reporting_tick_votes" ADD CONSTRAINT "gym_reporting_tick_votes_tick_id_boardsesh_ticks_id_fk" FOREIGN KEY ("tick_id") REFERENCES "public"."boardsesh_ticks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gym_climb_comment_attribution_board_time_idx" ON "gym_climb_comment_attributions" USING btree ("logical_board_id","comment_created_at","comment_id");