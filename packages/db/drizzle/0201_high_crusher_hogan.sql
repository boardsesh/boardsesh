CREATE TABLE "gym_owner_reassignments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"gym_uuid" text NOT NULL,
	"previous_owner_id" text NOT NULL,
	"new_owner_id" text NOT NULL,
	"sync_frozen_at_before" timestamp,
	"sync_frozen_at_after" timestamp,
	"reason" text NOT NULL,
	"performed_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "gym_owner_reassignments_gym_history_idx" ON "gym_owner_reassignments" USING btree ("gym_uuid","created_at");--> statement-breakpoint
CREATE INDEX "gym_owner_reassignments_performed_by_idx" ON "gym_owner_reassignments" USING btree ("performed_by");