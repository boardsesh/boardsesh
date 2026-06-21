ALTER TABLE "aurora_credentials" ADD COLUMN IF NOT EXISTS "credential_failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "aurora_credentials" ADD COLUMN IF NOT EXISTS "last_credential_failure_at" timestamp;--> statement-breakpoint

UPDATE "aurora_credentials"
SET
  "credential_failure_count" = 2,
  "last_credential_failure_at" = COALESCE("updated_at", now()),
  "sync_status" = 'expired',
  "sync_error" = 'Login failed: Invalid username or password (expired after 2 failed credential attempts; reconnect to resume sync)',
  "updated_at" = now()
WHERE "board_type" <> 'kilter'
  AND "sync_error" = 'Login failed: Invalid username or password';--> statement-breakpoint
