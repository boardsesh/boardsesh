CREATE TABLE "auth_web_oauth_commands" (
	"command_hash" text PRIMARY KEY NOT NULL,
	"operation" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "auth_web_oauth_commands_hash" CHECK ("auth_web_oauth_commands"."command_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "auth_web_oauth_commands_operation" CHECK ("auth_web_oauth_commands"."operation" IN ('intent','resolve')),
	CONSTRAINT "auth_web_oauth_commands_deadline" CHECK ("auth_web_oauth_commands"."expires_at" > "auth_web_oauth_commands"."issued_at")
);
--> statement-breakpoint
CREATE TABLE "auth_web_oauth_intents" (
	"intent_hash" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"flow_hash" text NOT NULL,
	"actor_user_id" text,
	"actor_lineage_hash" text,
	"actor_observed_generation" integer,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "auth_web_oauth_intents_provider" CHECK ("auth_web_oauth_intents"."provider" IN ('apple','google','facebook')),
	CONSTRAINT "auth_web_oauth_intents_hashes" CHECK ("auth_web_oauth_intents"."intent_hash" ~ '^[0-9a-f]{64}$' AND "auth_web_oauth_intents"."flow_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "auth_web_oauth_intents_actor" CHECK (("auth_web_oauth_intents"."actor_user_id" IS NULL AND "auth_web_oauth_intents"."actor_lineage_hash" IS NULL AND "auth_web_oauth_intents"."actor_observed_generation" IS NULL) OR ("auth_web_oauth_intents"."actor_user_id" IS NOT NULL AND length("auth_web_oauth_intents"."actor_user_id") > 0 AND "auth_web_oauth_intents"."actor_lineage_hash" IS NOT NULL AND "auth_web_oauth_intents"."actor_lineage_hash" ~ '^[0-9a-f]{64}$' AND "auth_web_oauth_intents"."actor_observed_generation" IS NOT NULL AND "auth_web_oauth_intents"."actor_observed_generation" >= 0)),
	CONSTRAINT "auth_web_oauth_intents_deadline" CHECK ("auth_web_oauth_intents"."expires_at" > "auth_web_oauth_intents"."issued_at" AND "auth_web_oauth_intents"."expires_at" <= "auth_web_oauth_intents"."issued_at" + interval '15 minutes')
);
--> statement-breakpoint
CREATE INDEX "auth_web_oauth_commands_expiry_idx" ON "auth_web_oauth_commands" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "auth_web_oauth_intents_expiry_idx" ON "auth_web_oauth_intents" USING btree ("expires_at");