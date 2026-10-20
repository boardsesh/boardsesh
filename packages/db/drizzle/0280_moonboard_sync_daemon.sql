CREATE TABLE "moonboard_import_jobs" (
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"credential_version" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"owner" text,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"retry_at" timestamp with time zone,
	"last_error" text,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moonboard_import_jobs_user_id_account_id_pk" PRIMARY KEY("user_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "moonboard_logbook_entries" (
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"entry_id" text NOT NULL,
	"tick_uuid" text NOT NULL,
	CONSTRAINT "moonboard_logbook_entries_user_id_account_id_entry_id_pk" PRIMARY KEY("user_id","account_id","entry_id")
);
--> statement-breakpoint
CREATE TABLE "moonboard_media_state" (
	"problem_id" integer PRIMARY KEY NOT NULL,
	"expected_count" integer NOT NULL,
	"source_count" integer,
	"is_benchmark" integer DEFAULT 0 NOT NULL,
	"holdsetup" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moonboard_sync_state" (
	"key" text PRIMARY KEY NOT NULL,
	"owner" text,
	"lease_until" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"retry_at" timestamp with time zone,
	"last_error" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "moonboard_import_jobs" ADD CONSTRAINT "moonboard_import_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moonboard_logbook_entries" ADD CONSTRAINT "moonboard_logbook_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "moonboard_jobs_pending_idx" ON "moonboard_import_jobs" USING btree ("status","retry_at");--> statement-breakpoint
CREATE INDEX "moonboard_entries_tick_idx" ON "moonboard_logbook_entries" USING btree ("tick_uuid");