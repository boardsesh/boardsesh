CREATE SCHEMA "posthog_reporting";
--> statement-breakpoint
CREATE VIEW "posthog_reporting"."daily_signups" AS (select cast("created_at" as date) as "day", count(*) as "signups" from "users" group by cast("users"."created_at" as date));