CREATE TABLE "auth_provider_reauthentication_receipts" (
	"receipt_hash" text PRIMARY KEY NOT NULL,
	"intent_hash" text NOT NULL,
	"method" text NOT NULL,
	"proof_binding_hash" text NOT NULL,
	"proof_provider_subject" text,
	"authenticated_at" timestamp with time zone NOT NULL,
	"proof_expires_at" timestamp with time zone NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "auth_provider_reauthentication_hashes" CHECK ("auth_provider_reauthentication_receipts"."receipt_hash" ~ '^[a-f0-9]{64}$' AND "auth_provider_reauthentication_receipts"."intent_hash" ~ '^[a-f0-9]{64}$' AND "auth_provider_reauthentication_receipts"."proof_binding_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "auth_provider_reauthentication_method" CHECK (("auth_provider_reauthentication_receipts"."method" = 'password' AND "auth_provider_reauthentication_receipts"."proof_provider_subject" IS NULL)
        OR ("auth_provider_reauthentication_receipts"."method" = 'google-auth-time' AND "auth_provider_reauthentication_receipts"."proof_provider_subject" IS NOT NULL AND length("auth_provider_reauthentication_receipts"."proof_provider_subject") > 0)),
	CONSTRAINT "auth_provider_reauthentication_deadline" CHECK ("auth_provider_reauthentication_receipts"."authenticated_at" <= "auth_provider_reauthentication_receipts"."issued_at" AND "auth_provider_reauthentication_receipts"."expires_at" > "auth_provider_reauthentication_receipts"."issued_at"
        AND "auth_provider_reauthentication_receipts"."expires_at" <= "auth_provider_reauthentication_receipts"."authenticated_at" + interval '5 minutes' AND "auth_provider_reauthentication_receipts"."expires_at" <= "auth_provider_reauthentication_receipts"."proof_expires_at")
);
--> statement-breakpoint
CREATE TABLE "auth_provider_security_intents" (
	"intent_hash" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"user_id" text NOT NULL,
	"actor_credential_kind" text NOT NULL,
	"actor_credential_hash" text NOT NULL,
	"recovery_token_hash" text NOT NULL,
	"browser_binding_hash" text NOT NULL,
	"browser_version" integer NOT NULL,
	"browser_intent_hash" text NOT NULL,
	"browser_binding_expires_at" timestamp with time zone NOT NULL,
	"actor_session_id" text NOT NULL,
	"actor_generation" integer NOT NULL,
	"actor_authenticated_at" timestamp with time zone,
	"actor_link_guarded" boolean NOT NULL,
	"actor_requires_account_cutoff" boolean NOT NULL,
	"actor_expires_at" timestamp with time zone NOT NULL,
	"operation" text NOT NULL,
	"provider" text NOT NULL,
	"provider_subject" text,
	"flow_hash" text,
	"reauthentication_flow_hash" text,
	"reauthentication_nonce_hash" text,
	"projection_id" text NOT NULL,
	"normalizer_version" text NOT NULL,
	"writer_authority" text NOT NULL,
	"writer_epoch" integer NOT NULL,
	"phase" text DEFAULT 'pending' NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"prepared_at" timestamp with time zone,
	"preparation_token_hash" text,
	"reauthentication_receipt_hash" text,
	"proposed_credential_hash" text,
	"consumed_at" timestamp with time zone,
	"candidate_credential_hash" text,
	"recovery_expires_at" timestamp with time zone,
	CONSTRAINT "auth_provider_security_intent_hashes" CHECK ("auth_provider_security_intents"."intent_hash" ~ '^[a-f0-9]{64}$' AND "auth_provider_security_intents"."actor_credential_hash" ~ '^[a-f0-9]{64}$' AND "auth_provider_security_intents"."recovery_token_hash" ~ '^[a-f0-9]{64}$'
        AND "auth_provider_security_intents"."browser_binding_hash" ~ '^[a-f0-9]{64}$' AND "auth_provider_security_intents"."browser_intent_hash" ~ '^[a-f0-9]{64}$'
        AND ("auth_provider_security_intents"."flow_hash" IS NULL OR "auth_provider_security_intents"."flow_hash" ~ '^[a-f0-9]{64}$')
        AND ("auth_provider_security_intents"."reauthentication_flow_hash" IS NULL OR "auth_provider_security_intents"."reauthentication_flow_hash" ~ '^[a-f0-9]{64}$')
        AND ("auth_provider_security_intents"."reauthentication_nonce_hash" IS NULL OR "auth_provider_security_intents"."reauthentication_nonce_hash" ~ '^[a-f0-9]{64}$')
        AND ("auth_provider_security_intents"."preparation_token_hash" IS NULL OR "auth_provider_security_intents"."preparation_token_hash" ~ '^[a-f0-9]{64}$')
        AND ("auth_provider_security_intents"."reauthentication_receipt_hash" IS NULL OR "auth_provider_security_intents"."reauthentication_receipt_hash" ~ '^[a-f0-9]{64}$')
        AND ("auth_provider_security_intents"."proposed_credential_hash" IS NULL OR "auth_provider_security_intents"."proposed_credential_hash" ~ '^[a-f0-9]{64}$')
        AND ("auth_provider_security_intents"."candidate_credential_hash" IS NULL OR "auth_provider_security_intents"."candidate_credential_hash" ~ '^[a-f0-9]{64}$')),
	CONSTRAINT "auth_provider_security_intent_actor" CHECK (length("auth_provider_security_intents"."user_id") > 0 AND length("auth_provider_security_intents"."actor_session_id") > 0 AND "auth_provider_security_intents"."actor_generation" >= 0
        AND "auth_provider_security_intents"."browser_version" >= 0 AND "auth_provider_security_intents"."browser_version" < 2147483647
        AND "auth_provider_security_intents"."actor_credential_kind" IN ('legacy-jwe', 'canonical-token')
        AND (NOT "auth_provider_security_intents"."actor_link_guarded" OR "auth_provider_security_intents"."actor_authenticated_at" IS NOT NULL)),
	CONSTRAINT "auth_provider_security_intent_operation" CHECK ("auth_provider_security_intents"."operation" IN ('link', 'unlink')),
	CONSTRAINT "auth_provider_security_intent_provider" CHECK ("auth_provider_security_intents"."provider" IN ('google', 'apple')),
	CONSTRAINT "auth_provider_security_intent_subject" CHECK (("auth_provider_security_intents"."operation" = 'link' OR "auth_provider_security_intents"."provider_subject" IS NOT NULL)
        AND ("auth_provider_security_intents"."provider_subject" IS NULL OR length("auth_provider_security_intents"."provider_subject") > 0)),
	CONSTRAINT "auth_provider_security_intent_authority" CHECK ("auth_provider_security_intents"."writer_authority" IN ('current-store', 'better-auth') AND "auth_provider_security_intents"."writer_epoch" > 0),
	CONSTRAINT "auth_provider_security_intent_deadline" CHECK ("auth_provider_security_intents"."expires_at" > "auth_provider_security_intents"."issued_at" AND "auth_provider_security_intents"."expires_at" <= "auth_provider_security_intents"."issued_at" + interval '15 minutes'
        AND "auth_provider_security_intents"."expires_at" <= "auth_provider_security_intents"."actor_expires_at" AND "auth_provider_security_intents"."expires_at" <= "auth_provider_security_intents"."browser_binding_expires_at"),
	CONSTRAINT "auth_provider_security_intent_phase" CHECK (("auth_provider_security_intents"."phase" = 'pending' AND "auth_provider_security_intents"."prepared_at" IS NULL AND "auth_provider_security_intents"."preparation_token_hash" IS NULL AND "auth_provider_security_intents"."reauthentication_receipt_hash" IS NULL AND "auth_provider_security_intents"."proposed_credential_hash" IS NULL AND "auth_provider_security_intents"."consumed_at" IS NULL AND "auth_provider_security_intents"."candidate_credential_hash" IS NULL AND "auth_provider_security_intents"."recovery_expires_at" IS NULL)
        OR ("auth_provider_security_intents"."phase" = 'prepared' AND "auth_provider_security_intents"."prepared_at" IS NOT NULL AND "auth_provider_security_intents"."preparation_token_hash" IS NOT NULL AND "auth_provider_security_intents"."reauthentication_receipt_hash" IS NOT NULL AND "auth_provider_security_intents"."provider_subject" IS NOT NULL AND "auth_provider_security_intents"."consumed_at" IS NULL AND "auth_provider_security_intents"."candidate_credential_hash" IS NULL AND "auth_provider_security_intents"."recovery_expires_at" IS NULL)
        OR ("auth_provider_security_intents"."phase" = 'committed' AND "auth_provider_security_intents"."prepared_at" IS NOT NULL AND "auth_provider_security_intents"."preparation_token_hash" IS NOT NULL AND "auth_provider_security_intents"."reauthentication_receipt_hash" IS NOT NULL AND "auth_provider_security_intents"."provider_subject" IS NOT NULL AND "auth_provider_security_intents"."consumed_at" IS NOT NULL AND "auth_provider_security_intents"."candidate_credential_hash" IS NOT NULL AND "auth_provider_security_intents"."recovery_expires_at" IS NOT NULL)
        OR ("auth_provider_security_intents"."phase" = 'terminal' AND "auth_provider_security_intents"."consumed_at" IS NOT NULL AND "auth_provider_security_intents"."candidate_credential_hash" IS NULL AND "auth_provider_security_intents"."recovery_expires_at" IS NULL)),
	CONSTRAINT "auth_provider_security_intent_candidate" CHECK ("auth_provider_security_intents"."recovery_expires_at" IS NULL OR ("auth_provider_security_intents"."recovery_expires_at" > "auth_provider_security_intents"."consumed_at" AND "auth_provider_security_intents"."recovery_expires_at" <= "auth_provider_security_intents"."expires_at" AND "auth_provider_security_intents"."recovery_expires_at" <= "auth_provider_security_intents"."consumed_at" + interval '2 minutes'))
);
--> statement-breakpoint
ALTER TABLE "auth_security_mutation_events" DROP CONSTRAINT "auth_security_mutation_events_kind";--> statement-breakpoint
CREATE UNIQUE INDEX "auth_provider_reauthentication_active_idx" ON "auth_provider_reauthentication_receipts" USING btree ("intent_hash") WHERE "auth_provider_reauthentication_receipts"."consumed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "auth_provider_reauthentication_expiry_idx" ON "auth_provider_reauthentication_receipts" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_provider_security_operation_idx" ON "auth_provider_security_intents" USING btree ("operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_provider_security_flow_idx" ON "auth_provider_security_intents" USING btree ("provider","flow_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_provider_security_reauthentication_flow_idx" ON "auth_provider_security_intents" USING btree ("reauthentication_flow_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_provider_security_reauthentication_nonce_idx" ON "auth_provider_security_intents" USING btree ("reauthentication_nonce_hash");--> statement-breakpoint
CREATE INDEX "auth_provider_security_expiry_idx" ON "auth_provider_security_intents" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "auth_provider_security_recovery_expiry_idx" ON "auth_provider_security_intents" USING btree ("recovery_expires_at");--> statement-breakpoint
ALTER TABLE "auth_security_mutation_events" ADD CONSTRAINT "auth_security_mutation_events_kind" CHECK ("auth_security_mutation_events"."kind" IN ('password-set', 'password-change', 'password-reset', 'provider-link', 'provider-unlink', 'account-deletion', 'legacy-signout', 'native-signout', 'admin-revocation'));