CREATE TABLE "location_sync_gym_sources" (
	"source_key" text PRIMARY KEY NOT NULL,
	"gym_id" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "location_sync_gym_sources" ADD CONSTRAINT "location_sync_gym_sources_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "location_sync_gym_sources_gym_idx" ON "location_sync_gym_sources" USING btree ("gym_id");
