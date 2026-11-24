ALTER TABLE "gym_mcp_write_receipts" ALTER COLUMN "result" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "gym_mcp_write_receipts" ADD COLUMN "expires_at" timestamp with time zone DEFAULT now() + interval '7 days' NOT NULL;--> statement-breakpoint
CREATE INDEX "gym_mcp_write_receipts_expires_at_idx" ON "gym_mcp_write_receipts" USING btree ("expires_at");