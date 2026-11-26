CREATE TABLE "request_notification_push_budgets" (
	"recipient_id" text PRIMARY KEY NOT NULL,
	"day" date NOT NULL,
	"count" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "request_notification_push_budgets" ADD CONSTRAINT "request_notification_push_budgets_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;