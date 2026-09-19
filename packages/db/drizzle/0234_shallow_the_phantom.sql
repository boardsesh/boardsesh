CREATE TYPE "public"."spray_detection_status" AS ENUM('pending', 'running', 'done', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "spray_wall_detections" (
	"id" text PRIMARY KEY NOT NULL,
	"wall_id" bigint NOT NULL,
	"version_id" bigint NOT NULL,
	"requested_by" text,
	"photo_key" text NOT NULL,
	"photo_width" integer NOT NULL,
	"photo_height" integer NOT NULL,
	"model_version" text NOT NULL,
	"weights_sha256" text NOT NULL,
	"job_id" text NOT NULL,
	"status" "spray_detection_status" DEFAULT 'pending' NOT NULL,
	"attempt_token" text,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "spray_wall_detections" ADD CONSTRAINT "spray_wall_detections_wall_id_spray_walls_id_fk" FOREIGN KEY ("wall_id") REFERENCES "public"."spray_walls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spray_wall_detections" ADD CONSTRAINT "spray_wall_detections_version_id_spray_wall_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."spray_wall_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spray_wall_detections" ADD CONSTRAINT "spray_wall_detections_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "spray_wall_detections_version_idx" ON "spray_wall_detections" USING btree ("version_id","created_at");--> statement-breakpoint
CREATE INDEX "spray_wall_detections_requester_idx" ON "spray_wall_detections" USING btree ("requested_by","created_at");--> statement-breakpoint
CREATE INDEX "spray_wall_detections_pending_idx" ON "spray_wall_detections" USING btree ("status","created_at");