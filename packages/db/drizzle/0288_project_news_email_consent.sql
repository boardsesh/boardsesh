CREATE TABLE "user_project_news_email_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"subscribed" boolean NOT NULL,
	"source" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_project_news_email_events_source_check" CHECK ("user_project_news_email_events"."source" IN ('web', 'ios', 'android', 'email_link'))
);
--> statement-breakpoint
ALTER TABLE "user_project_news_email_events" ADD CONSTRAINT "user_project_news_email_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_project_news_email_events_user_id_idx" ON "user_project_news_email_events" USING btree ("user_id","id" DESC NULLS LAST);