CREATE TABLE "partner_connection_notices" (
	"connection_id" text NOT NULL,
	"generation" integer NOT NULL,
	"user_id" text NOT NULL,
	"client_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "partner_connection_notices_connection_id_generation_pk" PRIMARY KEY("connection_id","generation")
);
--> statement-breakpoint
CREATE TABLE "partner_developer_emails" (
	"user_id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"token_hash" text,
	"expires_at" timestamp with time zone,
	"requested_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "partner_app_cap_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"performed_by" text NOT NULL,
	"previous_max_active_connections" integer NOT NULL,
	"previous_max_new_connections_per_day" integer NOT NULL,
	"max_active_connections" integer NOT NULL,
	"max_new_connections_per_day" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "partner_connection_notices" ADD CONSTRAINT "partner_connection_notices_connection_id_oauth_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."oauth_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_connection_notices" ADD CONSTRAINT "partner_connection_notices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_connection_notices" ADD CONSTRAINT "partner_connection_notices_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_developer_emails" ADD CONSTRAINT "partner_developer_emails_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "partner_connection_notices_pending_idx" ON "partner_connection_notices" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX "partner_app_cap_audit_client_history_idx" ON "partner_app_cap_audit" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "partner_app_cap_audit_actor_idx" ON "partner_app_cap_audit" USING btree ("performed_by");