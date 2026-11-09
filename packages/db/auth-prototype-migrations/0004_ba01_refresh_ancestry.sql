CREATE TABLE "prototype_oauth_refresh_ancestor" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text NOT NULL,
	"authorization_code_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "prototype_oauth_refresh_ancestor_family_idx" ON "prototype_oauth_refresh_ancestor" USING btree ("client_id","user_id","authorization_code_id");