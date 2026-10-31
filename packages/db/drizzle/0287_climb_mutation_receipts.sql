CREATE TABLE "climb_mutation_receipts" (
	"operation_key" text PRIMARY KEY NOT NULL,
	"climb_uuid" text NOT NULL,
	"board_type" text NOT NULL,
	"user_id" text,
	"result" jsonb
);
--> statement-breakpoint
ALTER TABLE "climb_mutation_receipts" ADD CONSTRAINT "climb_mutation_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "climb_mutation_receipts_user_idx" ON "climb_mutation_receipts" USING btree ("user_id");