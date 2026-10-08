CREATE TABLE "user_activity_days" (
	"user_id" text NOT NULL,
	"day" date NOT NULL,
	"platform" text NOT NULL,
	CONSTRAINT "user_activity_days_user_id_day_platform_pk" PRIMARY KEY("user_id","day","platform"),
	CONSTRAINT "user_activity_days_platform_check" CHECK ("user_activity_days"."platform" IN ('web', 'ios', 'android', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "user_analytics_consent_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"analytics" text NOT NULL,
	"version" integer NOT NULL,
	"source" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_analytics_consent_events_analytics_check" CHECK ("user_analytics_consent_events"."analytics" IN ('granted', 'denied')),
	CONSTRAINT "user_analytics_consent_events_source_check" CHECK ("user_analytics_consent_events"."source" IN ('web', 'ios', 'android')),
	CONSTRAINT "user_analytics_consent_events_version_check" CHECK ("user_analytics_consent_events"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "user_activity_days" ADD CONSTRAINT "user_activity_days_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_analytics_consent_events" ADD CONSTRAINT "user_analytics_consent_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_activity_days_day_idx" ON "user_activity_days" USING btree ("day");--> statement-breakpoint
CREATE INDEX "user_analytics_consent_events_user_decided_idx" ON "user_analytics_consent_events" USING btree ("user_id","decided_at" DESC NULLS LAST);