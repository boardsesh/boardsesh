CREATE TABLE "integration_credentials" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"encrypted_access_token" text,
	"encrypted_refresh_token" text,
	"token_expires_at" timestamp,
	"external_account_id" text,
	"external_account_name" text,
	"scopes" text,
	"auto_sync_enabled" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"last_sync_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_exports" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"user_id" text NOT NULL,
	"session_type" text NOT NULL,
	"session_id" text NOT NULL,
	"external_activity_id" text,
	"status" text NOT NULL,
	"error" text,
	"synced_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "board_sessions" ADD COLUMN "timezone" text;--> statement-breakpoint
ALTER TABLE "integration_credentials" ADD CONSTRAINT "integration_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_exports" ADD CONSTRAINT "integration_exports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "unique_user_integration" ON "integration_credentials" USING btree ("user_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_integration_export" ON "integration_exports" USING btree ("provider","user_id","session_type","session_id");--> statement-breakpoint
CREATE INDEX "integration_exports_user_provider_idx" ON "integration_exports" USING btree ("user_id","provider");--> statement-breakpoint
CREATE INDEX "integration_exports_session_idx" ON "integration_exports" USING btree ("session_id");