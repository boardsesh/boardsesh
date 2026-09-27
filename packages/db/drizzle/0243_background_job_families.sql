ALTER TABLE "background_job_runs" ADD COLUMN "family" text DEFAULT 'worker-probe' NOT NULL;--> statement-breakpoint
ALTER TABLE "background_job_runs" ADD COLUMN "payload" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "background_job_runs" ADD COLUMN "singleton_key" text;--> statement-breakpoint
CREATE INDEX "background_job_runs_family_status_created_idx" ON "background_job_runs" USING btree ("family","status","created_at");