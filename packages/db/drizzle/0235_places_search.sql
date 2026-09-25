CREATE TABLE "place_imports" (
	"dataset" text PRIMARY KEY NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_count" integer NOT NULL,
	"sources" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "places" (
	"id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"country_code" text NOT NULL,
	"country" text NOT NULL,
	"region" text NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"population" bigint NOT NULL,
	"search_text" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "places_search_text_idx" ON "places" USING gin ("search_text" gin_trgm_ops);