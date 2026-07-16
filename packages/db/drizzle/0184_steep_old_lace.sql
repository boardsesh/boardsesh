CREATE TYPE "public"."gym_merge_audit_action" AS ENUM('merged', 'dismissed');--> statement-breakpoint
CREATE TABLE "gym_merge_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"action" "gym_merge_audit_action" NOT NULL,
	"canonical_gym_id" bigint,
	"duplicate_gym_id" bigint,
	"cluster_signature" text NOT NULL,
	"moved_counts" jsonb,
	"moved_rows" jsonb,
	"warnings" jsonb,
	"performed_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gym_merge_audit" ADD CONSTRAINT "gym_merge_audit_canonical_gym_id_gyms_id_fk" FOREIGN KEY ("canonical_gym_id") REFERENCES "public"."gyms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_merge_audit" ADD CONSTRAINT "gym_merge_audit_duplicate_gym_id_gyms_id_fk" FOREIGN KEY ("duplicate_gym_id") REFERENCES "public"."gyms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_merge_audit" ADD CONSTRAINT "gym_merge_audit_performed_by_users_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gym_merge_audit_signature_action_idx" ON "gym_merge_audit" USING btree ("cluster_signature","action");--> statement-breakpoint
CREATE INDEX "gym_merge_audit_canonical_idx" ON "gym_merge_audit" USING btree ("canonical_gym_id");