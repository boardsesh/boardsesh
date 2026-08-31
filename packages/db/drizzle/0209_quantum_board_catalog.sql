CREATE TABLE "board_catalog_sync_state" (
	"board_type" text NOT NULL,
	"source" text NOT NULL,
	"manifest_event_id" text,
	"manifest_created_at" bigint,
	"manifest_fingerprint" text,
	"hardware_fingerprint" text,
	"last_attempt_at" timestamp,
	"last_success_at" timestamp,
	"last_error" text,
	CONSTRAINT "board_catalog_sync_state_board_type_source_pk" PRIMARY KEY("board_type","source")
);
--> statement-breakpoint
CREATE TABLE "quantum_climb_metadata" (
	"climb_uuid" text PRIMARY KEY NOT NULL,
	"source_grade" integer,
	"is_standard" boolean DEFAULT false NOT NULL,
	"is_campusing" boolean DEFAULT false NOT NULL,
	"is_edge" boolean DEFAULT false NOT NULL,
	"uses_kickplate" boolean DEFAULT false NOT NULL,
	"allows_matching" boolean DEFAULT false NOT NULL,
	"tags" text[]
);
--> statement-breakpoint
ALTER TABLE "board_climbs" ADD COLUMN "controller_route_uuid" text;--> statement-breakpoint
ALTER TABLE "quantum_climb_metadata" ADD CONSTRAINT "quantum_climb_metadata_climb_fk" FOREIGN KEY ("climb_uuid") REFERENCES "public"."board_climbs"("uuid") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "board_climbs_controller_route_uuid_idx" ON "board_climbs" USING btree ("board_type","layout_id","controller_route_uuid") WHERE "board_climbs"."controller_route_uuid" IS NOT NULL;