CREATE TABLE "sitemap_tier2_climbs" (
	"board_type" text NOT NULL,
	"layout_id" integer NOT NULL,
	"climb_uuid" text NOT NULL,
	"angle" integer NOT NULL,
	"climb_name" text,
	"last_modified" timestamp NOT NULL,
	CONSTRAINT "sitemap_tier2_climbs_board_type_layout_id_climb_uuid_pk" PRIMARY KEY("board_type","layout_id","climb_uuid")
);
--> statement-breakpoint
CREATE TABLE "sitemap_tier2_groups" (
	"board_type" text NOT NULL,
	"layout_id" integer NOT NULL,
	"size_id" integer NOT NULL,
	"set_ids" integer[] NOT NULL,
	"item_count" integer NOT NULL,
	"last_modified" timestamp,
	"predicate_fingerprint" text NOT NULL,
	"refreshed_at" timestamp NOT NULL,
	CONSTRAINT "sitemap_tier2_groups_board_type_layout_id_pk" PRIMARY KEY("board_type","layout_id")
);
