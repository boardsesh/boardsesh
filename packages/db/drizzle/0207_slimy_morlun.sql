CREATE TABLE "hold_outline_overrides" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"board_name" text NOT NULL,
	"layout_id" integer NOT NULL,
	"size_id" integer NOT NULL,
	"placement_id" integer NOT NULL,
	"outline" jsonb NOT NULL,
	"note" text,
	"author_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hold_outline_overrides" ADD CONSTRAINT "hold_outline_overrides_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hold_outline_overrides_placement_idx" ON "hold_outline_overrides" USING btree ("board_name","layout_id","size_id","placement_id");--> statement-breakpoint
CREATE INDEX "hold_outline_overrides_config_idx" ON "hold_outline_overrides" USING btree ("board_name","layout_id","size_id");