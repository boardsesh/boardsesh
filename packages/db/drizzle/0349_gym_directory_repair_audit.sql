CREATE TABLE "gym_directory_repair_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"operation" text NOT NULL,
	"gym_id" bigint NOT NULL,
	"gym_uuid" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"reason" text NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"details" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "gym_directory_repair_audit_gym_history_idx" ON "gym_directory_repair_audit" USING btree ("gym_uuid","created_at");--> statement-breakpoint
CREATE INDEX "gym_directory_repair_audit_actor_idx" ON "gym_directory_repair_audit" USING btree ("actor_user_id");