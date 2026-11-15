CREATE TABLE "cnc_computations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text,
	"operation" text NOT NULL,
	"request_hash" text NOT NULL,
	"generator_sha" text NOT NULL,
	"request" jsonb NOT NULL,
	"asset_keys" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"run_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"result" jsonb,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cnc_orders" ADD COLUMN "generation_run_id" uuid;--> statement-breakpoint
ALTER TABLE "cnc_orders" ADD COLUMN "notification_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cnc_orders" ADD COLUMN "notification_status" text;--> statement-breakpoint
ALTER TABLE "cnc_orders" ADD COLUMN "notification_claim_token" uuid;--> statement-breakpoint
ALTER TABLE "cnc_orders" ADD COLUMN "notification_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cnc_computations" ADD CONSTRAINT "cnc_computations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cnc_computations_owner_hash_idx" ON "cnc_computations" USING btree ("owner_id","request_hash");--> statement-breakpoint
CREATE INDEX "cnc_computations_expiry_idx" ON "cnc_computations" USING btree ("expires_at");