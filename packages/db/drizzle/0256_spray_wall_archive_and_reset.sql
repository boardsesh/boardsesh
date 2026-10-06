ALTER TABLE "spray_walls" ADD COLUMN "archived_at" timestamp;--> statement-breakpoint
ALTER TABLE "spray_walls" ADD COLUMN "reset_from_wall_id" bigint;--> statement-breakpoint
ALTER TABLE "spray_walls" ADD CONSTRAINT "spray_walls_reset_from_wall_id_spray_walls_id_fk" FOREIGN KEY ("reset_from_wall_id") REFERENCES "public"."spray_walls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "spray_walls_reset_from_wall_idx" ON "spray_walls" USING btree ("reset_from_wall_id") WHERE "spray_walls"."reset_from_wall_id" IS NOT NULL;