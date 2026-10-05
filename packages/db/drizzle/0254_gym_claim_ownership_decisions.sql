CREATE TABLE "gym_claim_ownership_decisions" (
	"claim_id" bigint PRIMARY KEY NOT NULL,
	"gym_uuid" text NOT NULL,
	"did_transfer" boolean NOT NULL,
	"decided_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gym_claim_ownership_decisions" ADD CONSTRAINT "gym_claim_ownership_decisions_claim_id_gym_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."gym_claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gym_claim_ownership_decisions_transfer_history_idx" ON "gym_claim_ownership_decisions" USING btree ("gym_uuid","decided_at") WHERE "gym_claim_ownership_decisions"."did_transfer";