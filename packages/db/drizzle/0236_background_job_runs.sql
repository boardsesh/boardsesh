CREATE TABLE "background_job_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"queue" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt_number" integer DEFAULT -1 NOT NULL,
	"attempt_token" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"deadline_at" timestamp with time zone NOT NULL,
	"error_code" text
);
--> statement-breakpoint
CREATE INDEX "background_job_runs_status_created_idx" ON "background_job_runs" USING btree ("status","created_at");