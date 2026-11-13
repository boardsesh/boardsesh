CREATE TABLE "auth_browser_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"intent_revision" integer DEFAULT 0 NOT NULL,
	"user_id" text,
	"credential_kind" text,
	"auth_session_id" text,
	"generation" integer,
	"authenticated_at" timestamp with time zone,
	"credential_expires_at" timestamp with time zone,
	"requires_account_cutoff" boolean DEFAULT false NOT NULL,
	"link_guarded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "auth_browser_binding_digest" CHECK ("auth_browser_bindings"."id" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "auth_browser_binding_versions" CHECK ("auth_browser_bindings"."version" >= 0 AND "auth_browser_bindings"."intent_revision" >= 0),
	CONSTRAINT "auth_browser_binding_deadline" CHECK ("auth_browser_bindings"."expires_at" > "auth_browser_bindings"."created_at"),
	CONSTRAINT "auth_browser_binding_selection" CHECK ((
    "auth_browser_bindings"."user_id" IS NULL AND "auth_browser_bindings"."credential_kind" IS NULL AND "auth_browser_bindings"."auth_session_id" IS NULL AND "auth_browser_bindings"."generation" IS NULL
    AND "auth_browser_bindings"."authenticated_at" IS NULL AND "auth_browser_bindings"."credential_expires_at" IS NULL
    AND NOT "auth_browser_bindings"."requires_account_cutoff" AND NOT "auth_browser_bindings"."link_guarded"
  ) OR (
    "auth_browser_bindings"."user_id" IS NOT NULL AND "auth_browser_bindings"."credential_kind" IS NOT NULL AND "auth_browser_bindings"."credential_kind" IN ('legacy-jwe', 'canonical-token') AND "auth_browser_bindings"."auth_session_id" IS NOT NULL AND "auth_browser_bindings"."generation" IS NOT NULL AND "auth_browser_bindings"."generation" >= 0
    AND "auth_browser_bindings"."credential_expires_at" IS NOT NULL
    AND (NOT "auth_browser_bindings"."link_guarded" OR "auth_browser_bindings"."authenticated_at" IS NOT NULL)
  ))
);
--> statement-breakpoint
CREATE TABLE "auth_browser_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"binding_id" text NOT NULL,
	"revision" integer NOT NULL,
	"expected_version" integer NOT NULL,
	"operation" text NOT NULL,
	"projection_id" text NOT NULL,
	"authority" text NOT NULL,
	"epoch" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"result_version" integer,
	CONSTRAINT "auth_browser_intent_digest" CHECK ("auth_browser_intents"."id" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "auth_browser_intent_versions" CHECK ("auth_browser_intents"."revision" > 0 AND "auth_browser_intents"."expected_version" >= 0 AND "auth_browser_intents"."epoch" > 0),
	CONSTRAINT "auth_browser_intent_operation" CHECK ("auth_browser_intents"."operation" IN ('login', 'logout', 'replacement')),
	CONSTRAINT "auth_browser_intent_authority" CHECK ("auth_browser_intents"."authority" IN ('current-store', 'better-auth')),
	CONSTRAINT "auth_browser_intent_deadline" CHECK ("auth_browser_intents"."expires_at" > "auth_browser_intents"."created_at"),
	CONSTRAINT "auth_browser_intent_consumption" CHECK (("auth_browser_intents"."consumed_at" IS NULL AND "auth_browser_intents"."result_version" IS NULL)
    OR ("auth_browser_intents"."consumed_at" IS NOT NULL AND "auth_browser_intents"."result_version" IS NOT NULL AND "auth_browser_intents"."result_version" = "auth_browser_intents"."expected_version" + 1))
);
--> statement-breakpoint
ALTER TABLE "auth_browser_intents" ADD CONSTRAINT "auth_browser_intents_binding_id_auth_browser_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."auth_browser_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_browser_binding_expiry_idx" ON "auth_browser_bindings" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "auth_browser_intent_binding_idx" ON "auth_browser_intents" USING btree ("binding_id");--> statement-breakpoint
CREATE INDEX "auth_browser_intent_expiry_idx" ON "auth_browser_intents" USING btree ("expires_at");