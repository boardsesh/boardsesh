CREATE TABLE "auth_email_resolution_log" (
	"batch_id" text NOT NULL,
	"group_reference" text NOT NULL,
	"user_id" text NOT NULL,
	"action" text NOT NULL,
	"evidence_kind" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_email_resolution_log_batch_id_group_reference_user_id_pk" PRIMARY KEY("batch_id","group_reference","user_id")
);
--> statement-breakpoint
CREATE INDEX "auth_email_resolution_group_idx" ON "auth_email_resolution_log" USING btree ("group_reference","recorded_at");