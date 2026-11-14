CREATE TABLE "auth_browser_renewals" (
	"operation_hash" text PRIMARY KEY NOT NULL,
	"preparation_hash" text NOT NULL,
	"nonce_hash" text NOT NULL,
	"binding_id" text NOT NULL,
	"binding_version" integer NOT NULL,
	"intent_revision" integer NOT NULL,
	"actor_credential_hash" text NOT NULL,
	"user_id" text NOT NULL,
	"auth_session_id" text NOT NULL,
	"projection_id" text NOT NULL,
	"normalizer_version" text NOT NULL,
	"authority" text NOT NULL,
	"epoch" integer NOT NULL,
	"preparation" jsonb NOT NULL,
	"metadata_hash" text NOT NULL,
	"prepared_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"candidate_hash" text,
	"result_version" integer,
	"completed_at" timestamp with time zone,
	"acknowledge_until" timestamp with time zone,
	CONSTRAINT "auth_browser_renewals_hashes" CHECK ("auth_browser_renewals"."operation_hash" ~ '^[a-f0-9]{64}$' AND "auth_browser_renewals"."preparation_hash" ~ '^[a-f0-9]{64}$' AND "auth_browser_renewals"."nonce_hash" ~ '^[a-f0-9]{64}$' AND "auth_browser_renewals"."binding_id" ~ '^[a-f0-9]{64}$' AND "auth_browser_renewals"."actor_credential_hash" ~ '^[a-f0-9]{64}$' AND "auth_browser_renewals"."metadata_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "auth_browser_renewals_versions" CHECK ("auth_browser_renewals"."binding_version" >= 0 AND "auth_browser_renewals"."intent_revision" >= 0 AND "auth_browser_renewals"."epoch" > 0),
	CONSTRAINT "auth_browser_renewals_authority" CHECK ("auth_browser_renewals"."authority" IN ('current-store', 'better-auth')),
	CONSTRAINT "auth_browser_renewals_deadline" CHECK ("auth_browser_renewals"."expires_at" > "auth_browser_renewals"."prepared_at" AND "auth_browser_renewals"."expires_at" <= "auth_browser_renewals"."prepared_at" + interval '1 minute'),
	CONSTRAINT "auth_browser_renewals_result" CHECK (("auth_browser_renewals"."candidate_hash" IS NULL AND "auth_browser_renewals"."result_version" IS NULL AND "auth_browser_renewals"."completed_at" IS NULL AND "auth_browser_renewals"."acknowledge_until" IS NULL) OR ("auth_browser_renewals"."candidate_hash" IS NOT NULL AND "auth_browser_renewals"."candidate_hash" ~ '^[a-f0-9]{64}$' AND "auth_browser_renewals"."result_version" IS NOT NULL AND "auth_browser_renewals"."result_version" = "auth_browser_renewals"."binding_version" + 1 AND "auth_browser_renewals"."completed_at" IS NOT NULL AND "auth_browser_renewals"."acknowledge_until" IS NOT NULL AND "auth_browser_renewals"."acknowledge_until" > "auth_browser_renewals"."completed_at" AND "auth_browser_renewals"."acknowledge_until" <= "auth_browser_renewals"."completed_at" + interval '5 minutes'))
);
--> statement-breakpoint
CREATE INDEX "auth_browser_renewals_binding_idx" ON "auth_browser_renewals" USING btree ("binding_id","binding_version");--> statement-breakpoint
CREATE INDEX "auth_browser_renewals_expiry_idx" ON "auth_browser_renewals" USING btree ("expires_at");