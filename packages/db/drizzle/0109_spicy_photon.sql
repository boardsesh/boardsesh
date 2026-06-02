CREATE TABLE "board_climb_ratings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"board_type" text NOT NULL,
	"climb_uuid" text NOT NULL,
	"angle" integer NOT NULL,
	"user_id" text NOT NULL,
	"rating" integer,
	"difficulty_grade_id" integer,
	"comment" text DEFAULT '',
	"weight" double precision,
	"kilter_id" text,
	"aurora_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "board_climb_ratings" ADD CONSTRAINT "board_climb_ratings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "board_climb_ratings_user_climb_angle_idx" ON "board_climb_ratings" USING btree ("board_type","climb_uuid","angle","user_id");--> statement-breakpoint
CREATE INDEX "board_climb_ratings_climb_idx" ON "board_climb_ratings" USING btree ("board_type","climb_uuid");--> statement-breakpoint
CREATE UNIQUE INDEX "board_climb_ratings_kilter_id_unique" ON "board_climb_ratings" USING btree ("kilter_id") WHERE "board_climb_ratings"."kilter_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "board_climb_ratings_aurora_id_unique" ON "board_climb_ratings" USING btree ("aurora_id") WHERE "aurora_id" IS NOT NULL;
