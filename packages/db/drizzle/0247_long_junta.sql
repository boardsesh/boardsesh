CREATE INDEX "board_climbs_user_export_idx" ON "board_climbs" USING btree ("user_id","board_type") WHERE "board_climbs"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "background_job_runs_family_singleton_created_idx" ON "background_job_runs" USING btree ("family","singleton_key","created_at");
