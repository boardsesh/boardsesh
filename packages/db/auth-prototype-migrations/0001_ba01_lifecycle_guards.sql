CREATE TABLE "prototype_legacy_lineage" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"original_authenticated_at" timestamp with time zone,
	"original_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "prototype_user_cutoff" (
	"user_id" text PRIMARY KEY NOT NULL,
	"revoked_through" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prototype_oauth_connection" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"client_id" text NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "prototype_oauth_interaction" (
	"digest" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"client_id" text NOT NULL,
	"connection_generation" integer NOT NULL,
	"created_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp
);
--> statement-breakpoint
CREATE UNIQUE INDEX "prototype_oauth_connection_user_client_unique" ON "prototype_oauth_connection" USING btree ("user_id","client_id");