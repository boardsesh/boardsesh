CREATE TABLE "stripe_support_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"checkout_session_id" text,
	"checkout_expires_at" timestamp,
	"cadence" text NOT NULL,
	"show_publicly" boolean DEFAULT false NOT NULL,
	"currency" text,
	"src" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_support_claims_cadence_check" CHECK ("stripe_support_claims"."cadence" IN ('monthly', 'one_time')),
	CONSTRAINT "stripe_support_claims_currency_check" CHECK ("stripe_support_claims"."currency" IS NULL OR "stripe_support_claims"."currency" IN ('aud', 'usd')),
	CONSTRAINT "stripe_support_claims_id_prefix_check" CHECK (left("stripe_support_claims"."id", 3) = 'sc_')
);
--> statement-breakpoint
CREATE TABLE "stripe_support_operations" (
	"user_id" text PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'idle' NOT NULL,
	"operation_id" text,
	"owner_token" text,
	"lease_expires_at" timestamp,
	"deletion_intent" jsonb
);
--> statement-breakpoint
CREATE TABLE "stripe_supporters" (
	"user_id" text PRIMARY KEY NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"subscription_status" text,
	"stripe_event_created_at" timestamp,
	"show_publicly" boolean DEFAULT false NOT NULL,
	"supported_at" timestamp,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'stripe' NOT NULL,
	"credit_until" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_supporters_source_check" CHECK ("stripe_supporters"."source" IN ('stripe', 'github_sponsors', 'admin'))
);
--> statement-breakpoint
ALTER TABLE "stripe_support_claims" ADD CONSTRAINT "stripe_support_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_support_operations" ADD CONSTRAINT "stripe_support_operations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_supporters" ADD CONSTRAINT "stripe_supporters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_support_claims_checkout_unique" ON "stripe_support_claims" USING btree ("checkout_session_id") WHERE "stripe_support_claims"."checkout_session_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "stripe_support_claims_user_idx" ON "stripe_support_claims" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "stripe_supporters_customer_idx" ON "stripe_supporters" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_supporters_subscription_unique" ON "stripe_supporters" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE INDEX "stripe_supporters_public_idx" ON "stripe_supporters" USING btree ("show_publicly","supported_at");