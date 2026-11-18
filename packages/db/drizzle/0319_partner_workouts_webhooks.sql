CREATE TABLE "app_workout_requests" (
	"client_id" text NOT NULL,
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"body_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"connection_generation" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "app_workout_requests_client_id_user_id_key_pk" PRIMARY KEY("client_id","user_id","key")
);
--> statement-breakpoint
CREATE TABLE "app_workouts" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"connection_generation" integer NOT NULL,
	"external_ref" text NOT NULL,
	"title" text NOT NULL,
	"spec" jsonb NOT NULL,
	"plan_snapshot" jsonb,
	"status" text DEFAULT 'created' NOT NULL,
	"session_id" text,
	"opened_by_mismatch" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_client_webhooks" (
	"client_id" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"events" text[] NOT NULL,
	"secret" text NOT NULL,
	"previous_secret" text,
	"previous_secret_expires_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"failing_since" timestamp with time zone,
	"disabled_reason" text,
	"failure_email_pending" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_webhook_debounce" (
	"connection_id" text NOT NULL,
	"connection_generation" integer NOT NULL,
	"last_enqueued_at" timestamp with time zone NOT NULL,
	"pending" boolean DEFAULT false NOT NULL,
	CONSTRAINT "partner_webhook_debounce_connection_id_connection_generation_pk" PRIMARY KEY("connection_id","connection_generation")
);
--> statement-breakpoint
CREATE TABLE "partner_webhook_feed_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"feed_generation" uuid NOT NULL,
	"txid" text DEFAULT '0' NOT NULL,
	"seq" text DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_webhook_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"connection_generation" integer NOT NULL,
	"type" text NOT NULL,
	"subject" text NOT NULL,
	"workout_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"relayed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"connection_generation" integer NOT NULL,
	"endpoint_version" integer NOT NULL,
	"event" text NOT NULL,
	"raw_body" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_status_code" integer,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "webhook_deliveries_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
ALTER TABLE "app_workout_requests" ADD CONSTRAINT "app_workout_requests_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_workout_requests" ADD CONSTRAINT "app_workout_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_workouts" ADD CONSTRAINT "app_workouts_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_workouts" ADD CONSTRAINT "app_workouts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_workouts" ADD CONSTRAINT "app_workouts_connection_id_oauth_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."oauth_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_workouts" ADD CONSTRAINT "app_workouts_session_id_board_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."board_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_webhooks" ADD CONSTRAINT "oauth_client_webhooks_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_webhook_outbox" ADD CONSTRAINT "partner_webhook_outbox_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_workout_requests_expiry_idx" ON "app_workout_requests" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "app_workouts_external_ref_idx" ON "app_workouts" USING btree ("client_id","user_id","external_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "app_workouts_session_user_idx" ON "app_workouts" USING btree ("session_id","user_id");--> statement-breakpoint
CREATE INDEX "app_workouts_connection_status_idx" ON "app_workouts" USING btree ("connection_id","status");--> statement-breakpoint
CREATE INDEX "app_workouts_app_user_status_idx" ON "app_workouts" USING btree ("client_id","user_id","status");--> statement-breakpoint
CREATE INDEX "app_workouts_expiry_idx" ON "app_workouts" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "partner_webhook_outbox_pending_idx" ON "partner_webhook_outbox" USING btree ("occurred_at") WHERE "partner_webhook_outbox"."relayed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "partner_webhook_revocation_generation_idx" ON "partner_webhook_outbox" USING btree ("connection_id","connection_generation") WHERE "partner_webhook_outbox"."type" = 'connection.revoked';--> statement-breakpoint
CREATE UNIQUE INDEX "partner_webhook_workout_completion_idx" ON "partner_webhook_outbox" USING btree ("workout_id") WHERE "partner_webhook_outbox"."type" = 'workout.completed';--> statement-breakpoint
CREATE INDEX "webhook_deliveries_client_created_idx" ON "webhook_deliveries" USING btree ("client_id","created_at");