CREATE TABLE "offline_write_deliveries" (
	"user_id" text NOT NULL,
	"delivery_id" text NOT NULL,
	"table_name" text NOT NULL,
	"operation" text NOT NULL,
	"binding_hash" text,
	"queued_at" timestamp with time zone,
	"connectivity_reason" text,
	"origin_release" jsonb,
	"observed_release" jsonb,
	"receiving_release" jsonb,
	"rejection_release" jsonb,
	"client_state" text,
	"client_revision" integer DEFAULT 0 NOT NULL,
	"client_observed_at" timestamp with time zone,
	"client_server_response_at" timestamp with time zone,
	"client_reconciled_at" timestamp with time zone,
	"first_dead_letter_at" timestamp with time zone,
	"last_dead_letter_at" timestamp with time zone,
	"recovered" boolean DEFAULT false NOT NULL,
	"server_accepted_at" timestamp with time zone,
	"server_rejected_at" timestamp with time zone,
	"server_rejection_code" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_reported_at" timestamp with time zone,
	"reconciled_reported_at" timestamp with time zone,
	CONSTRAINT "offline_write_deliveries_user_id_delivery_id_pk" PRIMARY KEY("user_id","delivery_id")
);
--> statement-breakpoint
ALTER TABLE "offline_write_deliveries" ADD CONSTRAINT "offline_write_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "offline_write_deliveries_cohort_idx" ON "offline_write_deliveries" USING btree ("first_seen_at","connectivity_reason");