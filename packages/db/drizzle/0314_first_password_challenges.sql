CREATE TABLE "auth_first_password_challenges" (
	"challenge_hash" text PRIMARY KEY NOT NULL,
	"purpose" text DEFAULT 'first-password' NOT NULL,
	"operation_id" text NOT NULL,
	"user_id" text NOT NULL,
	"email_binding_hash" text NOT NULL,
	"confirmation_token_hash" text NOT NULL,
	"recovery_token_hash" text NOT NULL,
	"actor_credential_kind" text NOT NULL,
	"actor_credential_hash" text NOT NULL,
	"actor_session_id" text NOT NULL,
	"actor_generation" integer NOT NULL,
	"actor_authenticated_at" timestamp with time zone,
	"actor_link_guarded" boolean NOT NULL,
	"actor_requires_account_cutoff" boolean NOT NULL,
	"actor_expires_at" timestamp with time zone NOT NULL,
	"browser_binding_hash" text NOT NULL,
	"browser_version" integer NOT NULL,
	"browser_intent_hash" text NOT NULL,
	"browser_binding_expires_at" timestamp with time zone NOT NULL,
	"projection_id" text NOT NULL,
	"normalizer_version" text NOT NULL,
	"writer_authority" text NOT NULL,
	"writer_epoch" integer NOT NULL,
	"phase" text DEFAULT 'pending' NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"pending_password_hash" text,
	"prepared_at" timestamp with time zone,
	"preparation_token_hash" text,
	"proposed_credential_hash" text,
	"consumed_at" timestamp with time zone,
	"candidate_credential_hash" text,
	"recovery_expires_at" timestamp with time zone,
	CONSTRAINT "auth_first_password_purpose" CHECK ("auth_first_password_challenges"."purpose" = 'first-password'),
	CONSTRAINT "auth_first_password_bcrypt" CHECK ("auth_first_password_challenges"."pending_password_hash" IS NULL
        OR "auth_first_password_challenges"."pending_password_hash" ~ '^[$]2[aby][$](0[4-9]|[12][0-9]|3[01])[$][./A-Za-z0-9]{53}$'),
	CONSTRAINT "auth_first_password_hashes" CHECK ("auth_first_password_challenges"."challenge_hash" ~ '^[a-f0-9]{64}$' AND "auth_first_password_challenges"."email_binding_hash" ~ '^[a-f0-9]{64}$'
        AND "auth_first_password_challenges"."confirmation_token_hash" ~ '^[a-f0-9]{64}$' AND "auth_first_password_challenges"."recovery_token_hash" ~ '^[a-f0-9]{64}$'
        AND "auth_first_password_challenges"."actor_credential_hash" ~ '^[a-f0-9]{64}$' AND "auth_first_password_challenges"."browser_binding_hash" ~ '^[a-f0-9]{64}$'
        AND "auth_first_password_challenges"."browser_intent_hash" ~ '^[a-f0-9]{64}$'
        AND ("auth_first_password_challenges"."preparation_token_hash" IS NULL OR "auth_first_password_challenges"."preparation_token_hash" ~ '^[a-f0-9]{64}$')
        AND ("auth_first_password_challenges"."proposed_credential_hash" IS NULL OR "auth_first_password_challenges"."proposed_credential_hash" ~ '^[a-f0-9]{64}$')
        AND ("auth_first_password_challenges"."candidate_credential_hash" IS NULL OR "auth_first_password_challenges"."candidate_credential_hash" ~ '^[a-f0-9]{64}$')),
	CONSTRAINT "auth_first_password_actor" CHECK (length("auth_first_password_challenges"."user_id") > 0 AND length("auth_first_password_challenges"."actor_session_id") > 0
        AND "auth_first_password_challenges"."actor_generation" >= 0 AND "auth_first_password_challenges"."actor_generation" < 2147483647
        AND "auth_first_password_challenges"."browser_version" >= 0 AND "auth_first_password_challenges"."browser_version" < 2147483647
        AND "auth_first_password_challenges"."actor_credential_kind" IN ('legacy-jwe', 'canonical-token')
        AND (NOT "auth_first_password_challenges"."actor_link_guarded" OR "auth_first_password_challenges"."actor_authenticated_at" IS NOT NULL)),
	CONSTRAINT "auth_first_password_authority" CHECK ("auth_first_password_challenges"."writer_authority" IN ('current-store', 'better-auth') AND "auth_first_password_challenges"."writer_epoch" > 0
        AND length("auth_first_password_challenges"."projection_id") > 0 AND length("auth_first_password_challenges"."normalizer_version") > 0),
	CONSTRAINT "auth_first_password_deadline" CHECK ("auth_first_password_challenges"."expires_at" > "auth_first_password_challenges"."issued_at" AND "auth_first_password_challenges"."expires_at" <= "auth_first_password_challenges"."issued_at" + interval '5 minutes'
        AND "auth_first_password_challenges"."expires_at" <= "auth_first_password_challenges"."actor_expires_at" AND "auth_first_password_challenges"."expires_at" <= "auth_first_password_challenges"."browser_binding_expires_at"
        AND ("auth_first_password_challenges"."prepared_at" IS NULL OR ("auth_first_password_challenges"."prepared_at" >= "auth_first_password_challenges"."issued_at" AND "auth_first_password_challenges"."prepared_at" < "auth_first_password_challenges"."expires_at"))
        AND ("auth_first_password_challenges"."consumed_at" IS NULL OR ("auth_first_password_challenges"."consumed_at" >= "auth_first_password_challenges"."issued_at"
          AND ("auth_first_password_challenges"."phase" = 'terminal' OR "auth_first_password_challenges"."consumed_at" <= "auth_first_password_challenges"."expires_at")))),
	CONSTRAINT "auth_first_password_phase" CHECK (("auth_first_password_challenges"."phase" = 'pending' AND "auth_first_password_challenges"."pending_password_hash" IS NULL AND "auth_first_password_challenges"."prepared_at" IS NULL
          AND "auth_first_password_challenges"."preparation_token_hash" IS NULL AND "auth_first_password_challenges"."proposed_credential_hash" IS NULL
          AND "auth_first_password_challenges"."consumed_at" IS NULL AND "auth_first_password_challenges"."candidate_credential_hash" IS NULL AND "auth_first_password_challenges"."recovery_expires_at" IS NULL)
        OR ("auth_first_password_challenges"."phase" = 'prepared' AND "auth_first_password_challenges"."pending_password_hash" IS NOT NULL AND "auth_first_password_challenges"."prepared_at" IS NOT NULL
          AND "auth_first_password_challenges"."preparation_token_hash" IS NOT NULL AND "auth_first_password_challenges"."consumed_at" IS NULL
          AND "auth_first_password_challenges"."candidate_credential_hash" IS NULL AND "auth_first_password_challenges"."recovery_expires_at" IS NULL)
        OR ("auth_first_password_challenges"."phase" = 'committed' AND "auth_first_password_challenges"."pending_password_hash" IS NULL AND "auth_first_password_challenges"."prepared_at" IS NOT NULL
          AND "auth_first_password_challenges"."preparation_token_hash" IS NOT NULL AND "auth_first_password_challenges"."consumed_at" IS NOT NULL
          AND "auth_first_password_challenges"."candidate_credential_hash" IS NOT NULL AND "auth_first_password_challenges"."recovery_expires_at" IS NOT NULL)
        OR ("auth_first_password_challenges"."phase" = 'terminal' AND "auth_first_password_challenges"."pending_password_hash" IS NULL AND "auth_first_password_challenges"."prepared_at" IS NULL
          AND "auth_first_password_challenges"."preparation_token_hash" IS NULL AND "auth_first_password_challenges"."proposed_credential_hash" IS NULL
          AND "auth_first_password_challenges"."consumed_at" IS NOT NULL AND "auth_first_password_challenges"."candidate_credential_hash" IS NULL AND "auth_first_password_challenges"."recovery_expires_at" IS NULL)),
	CONSTRAINT "auth_first_password_candidate" CHECK (("auth_first_password_challenges"."phase" NOT IN ('prepared', 'committed')
          OR ("auth_first_password_challenges"."actor_credential_kind" = 'canonical-token' AND "auth_first_password_challenges"."proposed_credential_hash" IS NOT NULL)
          OR ("auth_first_password_challenges"."actor_credential_kind" = 'legacy-jwe' AND "auth_first_password_challenges"."proposed_credential_hash" IS NULL))
        AND ("auth_first_password_challenges"."recovery_expires_at" IS NULL OR ("auth_first_password_challenges"."recovery_expires_at" > "auth_first_password_challenges"."consumed_at"
          AND "auth_first_password_challenges"."recovery_expires_at" <= "auth_first_password_challenges"."expires_at"
          AND "auth_first_password_challenges"."recovery_expires_at" <= "auth_first_password_challenges"."consumed_at" + interval '2 minutes')))
);
--> statement-breakpoint
ALTER TABLE "auth_first_password_challenges" ADD CONSTRAINT "auth_first_password_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_first_password_operation_idx" ON "auth_first_password_challenges" USING btree ("operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_first_password_active_user_idx" ON "auth_first_password_challenges" USING btree ("user_id") WHERE "auth_first_password_challenges"."consumed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "auth_first_password_expiry_idx" ON "auth_first_password_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "auth_first_password_recovery_expiry_idx" ON "auth_first_password_challenges" USING btree ("recovery_expires_at");