CREATE TABLE "aurora_username_claims" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"board_type" text NOT NULL,
	"aurora_username" text NOT NULL,
	"claimed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "aurora_username_claims" ADD CONSTRAINT "aurora_username_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "unique_user_board_claim" ON "aurora_username_claims" USING btree ("user_id","board_type");--> statement-breakpoint
CREATE INDEX "aurora_username_claims_lookup_idx" ON "aurora_username_claims" USING btree ("board_type","aurora_username");--> statement-breakpoint
CREATE INDEX "feed_items_entity_type_entity_id_idx" ON "feed_items" USING btree ("entity_type","entity_id");