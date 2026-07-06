CREATE TYPE "public"."gym_claim_method" AS ENUM('domain', 'admin');--> statement-breakpoint
CREATE TYPE "public"."gym_claim_status" AS ENUM('pending', 'approved', 'denied', 'expired');--> statement-breakpoint
ALTER TYPE "public"."gym_member_role" ADD VALUE 'editor' BEFORE 'member';--> statement-breakpoint
CREATE TABLE "gym_claims" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"gym_id" bigint NOT NULL,
	"claimant_user_id" text NOT NULL,
	"method" "gym_claim_method" NOT NULL,
	"status" "gym_claim_status" DEFAULT 'pending' NOT NULL,
	"claim_email" text,
	"message" text,
	"token_hash" text,
	"expires_at" timestamp,
	"reviewed_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gyms" ADD COLUMN "website" text;--> statement-breakpoint
ALTER TABLE "gym_claims" ADD CONSTRAINT "gym_claims_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_claims" ADD CONSTRAINT "gym_claims_claimant_user_id_users_id_fk" FOREIGN KEY ("claimant_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_claims" ADD CONSTRAINT "gym_claims_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gym_claims_gym_idx" ON "gym_claims" USING btree ("gym_id");--> statement-breakpoint
CREATE INDEX "gym_claims_claimant_idx" ON "gym_claims" USING btree ("claimant_user_id");--> statement-breakpoint
CREATE INDEX "gym_claims_status_idx" ON "gym_claims" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "gym_claims_token_hash_idx" ON "gym_claims" USING btree ("token_hash") WHERE "gym_claims"."token_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "gym_claims_unique_pending" ON "gym_claims" USING btree ("gym_id","claimant_user_id") WHERE "gym_claims"."status" = 'pending';