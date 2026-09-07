ALTER TYPE "public"."cnc_order_status" ADD VALUE 'preview_queued';--> statement-breakpoint
ALTER TYPE "public"."cnc_order_status" ADD VALUE 'preview_generating';--> statement-breakpoint
ALTER TYPE "public"."cnc_order_status" ADD VALUE 'preview_ready';--> statement-breakpoint
ALTER TYPE "public"."cnc_order_status" ADD VALUE 'preview_failed';--> statement-breakpoint
ALTER TABLE "cnc_orders" ALTER COLUMN "tier" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cnc_orders" ADD COLUMN "config_hash" text;--> statement-breakpoint
ALTER TABLE "cnc_orders" ADD COLUMN "preview_zip_key" text;--> statement-breakpoint
ALTER TABLE "cnc_orders" ADD COLUMN "preview_zip_size_bytes" bigint;--> statement-breakpoint
ALTER TABLE "cnc_orders" ADD COLUMN "preview_generated_at" timestamp;--> statement-breakpoint
ALTER TABLE "cnc_orders" ADD COLUMN "preview_keys" jsonb;--> statement-breakpoint
ALTER TABLE "cnc_orders" ADD COLUMN "previews_generated" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "cnc_orders_user_config_hash_idx" ON "cnc_orders" USING btree ("user_id","config_hash");