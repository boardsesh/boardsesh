CREATE TYPE "public"."location_sync_entity_type" AS ENUM('gym', 'board');--> statement-breakpoint
CREATE TABLE "location_sync_unfreeze_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"entity_type" "location_sync_entity_type" NOT NULL,
	"entity_uuid" text NOT NULL,
	"previous_sync_frozen_at" timestamp NOT NULL,
	"previous_deleted_at" timestamp,
	"previous_owner_id" text NOT NULL,
	"reason" text NOT NULL,
	"performed_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "location_sync_unfreeze_audit_entity_history_idx" ON "location_sync_unfreeze_audit" USING btree ("entity_type","entity_uuid","created_at");--> statement-breakpoint
CREATE INDEX "location_sync_unfreeze_audit_performed_by_idx" ON "location_sync_unfreeze_audit" USING btree ("performed_by");