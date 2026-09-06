CREATE TYPE "public"."cnc_licence_tier" AS ENUM('personal', 'commercial_single');--> statement-breakpoint
CREATE TYPE "public"."cnc_order_status" AS ENUM('pending_payment', 'queued', 'generating', 'ready', 'failed', 'cancelled', 'refunded');--> statement-breakpoint
CREATE TABLE "cnc_orders" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"licence_id" text NOT NULL,
	"user_id" text,
	"tier" "cnc_licence_tier" NOT NULL,
	"status" "cnc_order_status" NOT NULL,
	"board_name" text NOT NULL,
	"layout_id" integer NOT NULL,
	"size_id" integer NOT NULL,
	"set_ids" text NOT NULL,
	"options" jsonb NOT NULL,
	"artwork" jsonb,
	"catalog_version" text NOT NULL,
	"licensee_name" text,
	"licensee_email" text,
	"customer_site_name" text,
	"licence_accepted_at" timestamp,
	"currency" text,
	"amount_cents" integer,
	"stripe_checkout_session_id" text,
	"stripe_payment_intent_id" text,
	"paid_at" timestamp,
	"refunded_at" timestamp,
	"queued_at" timestamp,
	"claimed_at" timestamp,
	"heartbeat_at" timestamp,
	"worker_id" text,
	"claim_token" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"generation" integer DEFAULT 1 NOT NULL,
	"generated_at" timestamp,
	"zip_key" text,
	"zip_size_bytes" bigint,
	"zip_sha256" text,
	"fingerprint_manifest" jsonb,
	"download_count" integer DEFAULT 0 NOT NULL,
	"last_downloaded_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cnc_stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"order_id" bigint,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "cnc_orders" ADD CONSTRAINT "cnc_orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cnc_stripe_events" ADD CONSTRAINT "cnc_stripe_events_order_id_cnc_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."cnc_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cnc_orders_licence_id_unique" ON "cnc_orders" USING btree ("licence_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cnc_orders_stripe_checkout_session_unique" ON "cnc_orders" USING btree ("stripe_checkout_session_id");--> statement-breakpoint
CREATE INDEX "cnc_orders_stripe_payment_intent_idx" ON "cnc_orders" USING btree ("stripe_payment_intent_id");--> statement-breakpoint
CREATE INDEX "cnc_orders_user_created_idx" ON "cnc_orders" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cnc_orders_status_queued_idx" ON "cnc_orders" USING btree ("status","queued_at");