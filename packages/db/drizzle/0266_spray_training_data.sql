CREATE TYPE "public"."spray_hold_auto_review" AS ENUM('accepted', 'confirmed', 'edited');--> statement-breakpoint
CREATE TYPE "public"."spray_training_reject_reason" AS ENUM('bad_holds', 'missing_holds', 'photo_quality', 'not_a_wall', 'people_or_personal_info', 'duplicate', 'other');--> statement-breakpoint
CREATE TYPE "public"."spray_training_review_status" AS ENUM('approved', 'rejected');--> statement-breakpoint
CREATE TABLE "spray_wall_training_reviews" (
	"version_id" bigint PRIMARY KEY NOT NULL,
	"status" "spray_training_review_status" NOT NULL,
	"reject_reason" "spray_training_reject_reason",
	"notes" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spray_wall_training_reviews_reason_check" CHECK (("spray_wall_training_reviews"."status" = 'rejected') = ("spray_wall_training_reviews"."reject_reason" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "spray_wall_holds" ADD COLUMN "auto_review" "spray_hold_auto_review";--> statement-breakpoint
ALTER TABLE "spray_wall_holds" ADD COLUMN "origin_detection_id" text;--> statement-breakpoint
ALTER TABLE "spray_wall_holds" ADD COLUMN "origin_candidate_index" integer;--> statement-breakpoint
ALTER TABLE "spray_walls" ADD COLUMN "training_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "spray_wall_training_reviews" ADD CONSTRAINT "spray_wall_training_reviews_version_id_spray_wall_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."spray_wall_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spray_wall_training_reviews" ADD CONSTRAINT "spray_wall_training_reviews_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "spray_wall_training_reviews_status_idx" ON "spray_wall_training_reviews" USING btree ("status","reviewed_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "spray_wall_holds" ADD CONSTRAINT "spray_wall_holds_origin_detection_id_spray_wall_detections_id_fk" FOREIGN KEY ("origin_detection_id") REFERENCES "public"."spray_wall_detections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "spray_wall_holds_origin_detection_idx" ON "spray_wall_holds" USING btree ("origin_detection_id") WHERE "spray_wall_holds"."origin_detection_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "spray_wall_holds" ADD CONSTRAINT "spray_wall_holds_provenance_auto_only" CHECK ("spray_wall_holds"."source" = 'auto' OR ("spray_wall_holds"."auto_review" IS NULL AND "spray_wall_holds"."origin_detection_id" IS NULL));