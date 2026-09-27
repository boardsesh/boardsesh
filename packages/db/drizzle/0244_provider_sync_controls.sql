CREATE TABLE "provider_sync_controls" (
	"user_id" text NOT NULL,
	"board_type" text NOT NULL,
	"link_generation" uuid DEFAULT gen_random_uuid() NOT NULL,
	"linked" boolean DEFAULT true NOT NULL,
	"pending_run_id" uuid,
	"notify_requester" boolean DEFAULT false NOT NULL,
	"active_run_id" uuid,
	"active_lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_sync_controls_user_id_board_type_pk" PRIMARY KEY("user_id","board_type")
);
--> statement-breakpoint
ALTER TABLE "provider_sync_controls" ADD CONSTRAINT "provider_sync_controls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_sync_controls_active_run_idx" ON "provider_sync_controls" USING btree ("active_run_id") WHERE "provider_sync_controls"."active_run_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "provider_sync_controls_pending_run_idx" ON "provider_sync_controls" USING btree ("pending_run_id") WHERE "provider_sync_controls"."pending_run_id" IS NOT NULL;