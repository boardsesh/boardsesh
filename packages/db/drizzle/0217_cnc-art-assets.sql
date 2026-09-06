CREATE TABLE "cnc_art_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"width_px" integer,
	"height_px" integer,
	"sha256" text NOT NULL,
	"order_id" bigint,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cnc_art_assets" ADD CONSTRAINT "cnc_art_assets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cnc_art_assets" ADD CONSTRAINT "cnc_art_assets_order_id_cnc_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."cnc_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cnc_art_assets_key_unique" ON "cnc_art_assets" USING btree ("key");--> statement-breakpoint
CREATE INDEX "cnc_art_assets_user_created_idx" ON "cnc_art_assets" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cnc_art_assets_order_idx" ON "cnc_art_assets" USING btree ("order_id");