CREATE TABLE "kilter_catalog_checkpoints" (
	"scope_key" text PRIMARY KEY NOT NULL,
	"mapping_version" text NOT NULL,
	"baseline_started_at" timestamp with time zone,
	"baseline_completed_at" timestamp with time zone,
	"confirmed_through" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kilter_catalog_control" (
	"key" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"lease_until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kilter_catalog_deferred" (
	"source_uuid" text PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"reason" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kilter_catalog_deferred_lower_uuid" CHECK ("kilter_catalog_deferred"."source_uuid" = lower("kilter_catalog_deferred"."source_uuid"))
);
--> statement-breakpoint
CREATE TABLE "kilter_catalog_source_stats" (
	"source_uuid" text NOT NULL,
	"angle" integer NOT NULL,
	"canonical_uuid" text NOT NULL,
	"payload" jsonb NOT NULL,
	"scope_key" text DEFAULT '' NOT NULL,
	"generation" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kilter_catalog_source_stats_source_uuid_angle_pk" PRIMARY KEY("source_uuid","angle"),
	CONSTRAINT "kilter_catalog_source_stats_lower_uuid" CHECK ("kilter_catalog_source_stats"."source_uuid" = lower("kilter_catalog_source_stats"."source_uuid"))
);
--> statement-breakpoint
CREATE INDEX "kilter_catalog_source_stats_canonical_idx" ON "kilter_catalog_source_stats" USING btree ("canonical_uuid","angle");