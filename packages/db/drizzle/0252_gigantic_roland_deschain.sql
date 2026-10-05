DROP INDEX "stripe_support_claims_checkout_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_support_claims_checkout_unique" ON "stripe_support_claims" USING btree ("checkout_session_id") WHERE "stripe_support_claims"."checkout_session_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "stripe_support_claims" ADD CONSTRAINT "stripe_support_claims_cadence_check" CHECK ("stripe_support_claims"."cadence" IN ('monthly', 'one_time'));
