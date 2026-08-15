CREATE TABLE "sitemap_climb_urls" (
	"ordinal" integer PRIMARY KEY NOT NULL,
	"path" text NOT NULL,
	"last_modified" timestamp,
	"board_type" text NOT NULL,
	"layout_id" integer NOT NULL
);
