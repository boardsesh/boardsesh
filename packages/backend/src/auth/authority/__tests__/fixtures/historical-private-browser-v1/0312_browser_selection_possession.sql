ALTER TABLE "auth_browser_intents" ADD COLUMN "format_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_browser_intents" ADD COLUMN "actor_credential_hash" text;--> statement-breakpoint
ALTER TABLE "auth_browser_intents" ADD COLUMN "result_credential_hash" text;--> statement-breakpoint
ALTER TABLE "auth_browser_intents" ADD CONSTRAINT "auth_browser_intent_format" CHECK ("auth_browser_intents"."format_version" IN (1, 2));--> statement-breakpoint
ALTER TABLE "auth_browser_intents" ADD CONSTRAINT "auth_browser_intent_actor_hash" CHECK ("auth_browser_intents"."actor_credential_hash" IS NULL OR "auth_browser_intents"."actor_credential_hash" ~ '^[a-f0-9]{64}$');--> statement-breakpoint
ALTER TABLE "auth_browser_intents" ADD CONSTRAINT "auth_browser_intent_result_hash" CHECK ("auth_browser_intents"."result_credential_hash" IS NULL OR "auth_browser_intents"."result_credential_hash" ~ '^[a-f0-9]{64}$');