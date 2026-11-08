CREATE TABLE "auth_email_verification_state" (
	"user_id" text NOT NULL,
	"purpose" text NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_email_verification_state_user_id_purpose_pk" PRIMARY KEY("user_id","purpose"),
	CONSTRAINT "auth_email_verification_state_purpose" CHECK ("auth_email_verification_state"."purpose" = 'email-verification'),
	CONSTRAINT "auth_email_verification_state_generation" CHECK ("auth_email_verification_state"."generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE "auth_email_verification_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"purpose" text NOT NULL,
	"delivered_email" text NOT NULL,
	"normalized_email" text NOT NULL,
	"subject_generation" integer NOT NULL,
	"issuance_generation" integer NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "auth_email_verification_tokens_purpose" CHECK ("auth_email_verification_tokens"."purpose" = 'email-verification'),
	CONSTRAINT "auth_email_verification_token_hash" CHECK ("auth_email_verification_tokens"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "auth_email_verification_token_generations" CHECK ("auth_email_verification_tokens"."subject_generation" >= 0 AND "auth_email_verification_tokens"."issuance_generation" > 0),
	CONSTRAINT "auth_email_verification_token_address" CHECK (length("auth_email_verification_tokens"."delivered_email") > 0 AND length("auth_email_verification_tokens"."normalized_email") > 0),
	CONSTRAINT "auth_email_verification_token_deadline" CHECK ("auth_email_verification_tokens"."expires_at" > "auth_email_verification_tokens"."issued_at" AND "auth_email_verification_tokens"."expires_at" <= "auth_email_verification_tokens"."issued_at" + interval '24 hours'),
	CONSTRAINT "auth_email_verification_token_terminal" CHECK ("auth_email_verification_tokens"."consumed_at" IS NULL OR "auth_email_verification_tokens"."superseded_at" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "auth_email_verification_tokens" ADD CONSTRAINT "auth_email_verification_tokens_state_fk" FOREIGN KEY ("user_id","purpose") REFERENCES "public"."auth_email_verification_state"("user_id","purpose") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_email_verification_active_user_idx" ON "auth_email_verification_tokens" USING btree ("user_id","purpose") WHERE "auth_email_verification_tokens"."consumed_at" IS NULL AND "auth_email_verification_tokens"."superseded_at" IS NULL;--> statement-breakpoint
CREATE INDEX "auth_email_verification_expiry_idx" ON "auth_email_verification_tokens" USING btree ("expires_at");