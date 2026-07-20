CREATE TYPE "public"."cost_entry_kind" AS ENUM('recurring', 'incidental');--> statement-breakpoint
CREATE TABLE "cost_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" "cost_entry_kind" NOT NULL,
	"category" text NOT NULL,
	"label" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"start_month" text NOT NULL,
	"end_month" text,
	"note" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cost_entries_start_month_idx" ON "cost_entries" USING btree ("start_month");