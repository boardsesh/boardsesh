CREATE TABLE "account_consolidation_batches" (
	"batch_id" text PRIMARY KEY NOT NULL,
	"plan_sha256" text NOT NULL,
	"policy_version" integer NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "account_consolidation_batches_status" CHECK ("account_consolidation_batches"."status" IN ('planned','applying','applied','failed')),
	CONSTRAINT "account_consolidation_batches_policy" CHECK ("account_consolidation_batches"."policy_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "account_consolidation_group_audits" (
	"merge_id" text PRIMARY KEY NOT NULL,
	"batch_id" text NOT NULL,
	"group_reference" text NOT NULL,
	"before_fingerprint" text NOT NULL,
	"after_fingerprint" text NOT NULL,
	"counts" jsonb NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_consolidation_import_aliases" (
	"former_user_id" text NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"canonical_resource_id" text,
	"target_user_id" text NOT NULL,
	"merge_id" text NOT NULL,
	"tombstoned" boolean DEFAULT false NOT NULL,
	CONSTRAINT "account_consolidation_import_aliases_former_user_id_provider_kind_external_id_pk" PRIMARY KEY("former_user_id","provider","kind","external_id"),
	CONSTRAINT "account_consolidation_import_kind" CHECK ("account_consolidation_import_aliases"."kind" IN ('tick','playlist','climb')),
	CONSTRAINT "account_consolidation_import_tombstone" CHECK ("account_consolidation_import_aliases"."tombstoned" OR "account_consolidation_import_aliases"."canonical_resource_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "account_consolidation_members" (
	"source_user_id" text PRIMARY KEY NOT NULL,
	"canonical_user_id" text NOT NULL,
	"merge_id" text NOT NULL,
	"status" text NOT NULL,
	"source_generation_before" integer NOT NULL,
	"source_native_generation_before" integer NOT NULL,
	"source_generation_after" integer NOT NULL,
	"source_native_generation_after" integer NOT NULL,
	"target_generation" integer NOT NULL,
	"target_native_generation" integer NOT NULL,
	"native_bridge_revoked_at" timestamp with time zone,
	"web_bridge_revoked_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	CONSTRAINT "account_consolidation_members_distinct" CHECK ("account_consolidation_members"."source_user_id" <> "account_consolidation_members"."canonical_user_id"),
	CONSTRAINT "account_consolidation_members_status" CHECK ("account_consolidation_members"."status" IN ('planned','applied')),
	CONSTRAINT "account_consolidation_members_stamps" CHECK ("account_consolidation_members"."source_generation_before" >= 0 AND "account_consolidation_members"."source_native_generation_before" >= 0 AND "account_consolidation_members"."source_generation_after" = "account_consolidation_members"."source_generation_before" + 1 AND "account_consolidation_members"."source_native_generation_after" >= "account_consolidation_members"."source_native_generation_before" AND "account_consolidation_members"."target_generation" >= 0 AND "account_consolidation_members"."target_native_generation" >= 0),
	CONSTRAINT "account_consolidation_members_applied" CHECK ("account_consolidation_members"."status" <> 'applied' OR "account_consolidation_members"."applied_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "account_consolidation_session_aliases" (
	"retired_session_id" text PRIMARY KEY NOT NULL,
	"canonical_session_id" text,
	"target_user_id" text NOT NULL,
	"merge_id" text NOT NULL,
	"tombstoned" boolean DEFAULT false NOT NULL,
	CONSTRAINT "account_consolidation_session_alias_distinct" CHECK ("account_consolidation_session_aliases"."canonical_session_id" IS NULL OR "account_consolidation_session_aliases"."retired_session_id" <> "account_consolidation_session_aliases"."canonical_session_id"),
	CONSTRAINT "account_consolidation_session_alias_tombstone" CHECK ("account_consolidation_session_aliases"."tombstoned" OR "account_consolidation_session_aliases"."canonical_session_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "account_consolidation_session_proofs" (
	"credential_id" text PRIMARY KEY NOT NULL,
	"source_user_id" text NOT NULL,
	"merge_id" text NOT NULL,
	"kind" text NOT NULL,
	"canonical_session_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "account_consolidation_proofs_kind" CHECK ("account_consolidation_session_proofs"."kind" IN ('native-refresh','web-session'))
);
--> statement-breakpoint
CREATE TABLE "account_consolidation_tick_aliases" (
	"retired_uuid" text PRIMARY KEY NOT NULL,
	"canonical_uuid" text,
	"target_user_id" text NOT NULL,
	"merge_id" text NOT NULL,
	"tombstoned" boolean DEFAULT false NOT NULL,
	CONSTRAINT "account_consolidation_tick_alias_distinct" CHECK ("account_consolidation_tick_aliases"."canonical_uuid" IS NULL OR "account_consolidation_tick_aliases"."retired_uuid" <> "account_consolidation_tick_aliases"."canonical_uuid"),
	CONSTRAINT "account_consolidation_tick_alias_tombstone" CHECK ("account_consolidation_tick_aliases"."tombstoned" OR "account_consolidation_tick_aliases"."canonical_uuid" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "account_consolidation_batches_plan_idx" ON "account_consolidation_batches" USING btree ("plan_sha256");--> statement-breakpoint
CREATE INDEX "account_consolidation_members_target_idx" ON "account_consolidation_members" USING btree ("canonical_user_id");--> statement-breakpoint
CREATE INDEX "account_consolidation_proofs_source_idx" ON "account_consolidation_session_proofs" USING btree ("source_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_consolidation_proofs_session_idx" ON "account_consolidation_session_proofs" USING btree ("canonical_session_id");