CREATE TABLE "stripe_support_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"checkout_session_id" text,
	"cadence" text NOT NULL,
	"show_publicly" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
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
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stripe_support_claims" ADD CONSTRAINT "stripe_support_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_supporters" ADD CONSTRAINT "stripe_supporters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_support_claims_checkout_unique" ON "stripe_support_claims" USING btree ("checkout_session_id");--> statement-breakpoint
CREATE INDEX "stripe_support_claims_user_idx" ON "stripe_support_claims" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "stripe_supporters_customer_idx" ON "stripe_supporters" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_supporters_subscription_unique" ON "stripe_supporters" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE INDEX "stripe_supporters_public_idx" ON "stripe_supporters" USING btree ("show_publicly","supported_at");
