CREATE TABLE "gym_activity_stats" (
	"gym_id" bigint PRIMARY KEY NOT NULL,
	"distinct_users_all_time" integer DEFAULT 0 NOT NULL,
	"distinct_users_30d" integer DEFAULT 0 NOT NULL,
	"distinct_users_7d" integer DEFAULT 0 NOT NULL,
	"pushes_all_time" integer DEFAULT 0 NOT NULL,
	"pushes_30d" integer DEFAULT 0 NOT NULL,
	"board_count" integer DEFAULT 0 NOT NULL,
	"first_active_at" timestamp,
	"last_active_at" timestamp,
	"is_claimed" boolean DEFAULT false NOT NULL,
	"has_address" boolean DEFAULT false NOT NULL,
	"has_coords" boolean DEFAULT false NOT NULL,
	"has_website" boolean DEFAULT false NOT NULL,
	"has_contact_email" boolean DEFAULT false NOT NULL,
	"computed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gym_activity_stats" ADD CONSTRAINT "gym_activity_stats_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gym_activity_stats_recent_users_idx" ON "gym_activity_stats" USING btree ("distinct_users_30d");--> statement-breakpoint
CREATE INDEX "gym_activity_stats_all_time_users_idx" ON "gym_activity_stats" USING btree ("distinct_users_all_time");
