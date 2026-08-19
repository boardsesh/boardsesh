CREATE TABLE "sitemap_shard_refreshes" (
	"shard_id" text PRIMARY KEY NOT NULL,
	"item_count" integer NOT NULL,
	"last_modified" timestamp,
	"computed_at" timestamp DEFAULT now() NOT NULL
);
