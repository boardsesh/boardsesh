CREATE TABLE "auth_password_recovery_state" (
	"user_id" text NOT NULL,
	"purpose" text NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_password_recovery_state_user_id_purpose_pk" PRIMARY KEY("user_id","purpose"),
	CONSTRAINT "auth_password_recovery_state_purpose" CHECK ("auth_password_recovery_state"."purpose" = 'password-reset'),
	CONSTRAINT "auth_password_recovery_state_generation" CHECK ("auth_password_recovery_state"."generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE "auth_password_recovery_tokens" (
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
	CONSTRAINT "auth_password_recovery_tokens_purpose" CHECK ("auth_password_recovery_tokens"."purpose" = 'password-reset'),
	CONSTRAINT "auth_password_recovery_token_hash" CHECK ("auth_password_recovery_tokens"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "auth_password_recovery_token_generations" CHECK ("auth_password_recovery_tokens"."subject_generation" >= 0 AND "auth_password_recovery_tokens"."issuance_generation" > 0),
	CONSTRAINT "auth_password_recovery_token_address" CHECK (length("auth_password_recovery_tokens"."delivered_email") > 0 AND length("auth_password_recovery_tokens"."normalized_email") > 0),
	CONSTRAINT "auth_password_recovery_token_deadline" CHECK ("auth_password_recovery_tokens"."expires_at" > "auth_password_recovery_tokens"."issued_at" AND "auth_password_recovery_tokens"."expires_at" <= "auth_password_recovery_tokens"."issued_at" + interval '1 hour'),
	CONSTRAINT "auth_password_recovery_token_terminal" CHECK ("auth_password_recovery_tokens"."consumed_at" IS NULL OR "auth_password_recovery_tokens"."superseded_at" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "auth_password_recovery_tokens" ADD CONSTRAINT "auth_password_recovery_tokens_state_fk" FOREIGN KEY ("user_id","purpose") REFERENCES "public"."auth_password_recovery_state"("user_id","purpose") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_password_recovery_active_user_idx" ON "auth_password_recovery_tokens" USING btree ("user_id","purpose") WHERE "auth_password_recovery_tokens"."consumed_at" IS NULL AND "auth_password_recovery_tokens"."superseded_at" IS NULL;--> statement-breakpoint
CREATE INDEX "auth_password_recovery_expiry_idx" ON "auth_password_recovery_tokens" USING btree ("expires_at");