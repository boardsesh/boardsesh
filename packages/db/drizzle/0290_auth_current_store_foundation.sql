CREATE TABLE "auth_email_projection" (
	"projection_id" text PRIMARY KEY NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"normalizer_version" text NOT NULL,
	"phase" text NOT NULL,
	"writer_epoch" integer NOT NULL,
	"source_user_count" integer DEFAULT 0 NOT NULL,
	"key_count" integer DEFAULT 0 NOT NULL,
	"ambiguous_key_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"prepared_at" timestamp with time zone,
	CONSTRAINT "auth_email_projection_phase" CHECK ("auth_email_projection"."phase" IN ('preparing', 'prepared', 'enforced')),
	CONSTRAINT "auth_email_projection_epoch" CHECK ("auth_email_projection"."writer_epoch" > 0),
	CONSTRAINT "auth_email_projection_counts" CHECK ("auth_email_projection"."source_user_count" >= 0 AND "auth_email_projection"."key_count" >= 0 AND "auth_email_projection"."ambiguous_key_count" >= 0 AND "auth_email_projection"."ambiguous_key_count" <= "auth_email_projection"."key_count"),
	CONSTRAINT "auth_email_projection_completion" CHECK (("auth_email_projection"."phase" = 'preparing' AND "auth_email_projection"."prepared_at" IS NULL) OR ("auth_email_projection"."phase" IN ('prepared', 'enforced') AND "auth_email_projection"."prepared_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "auth_email_reservation_members" (
	"normalized_email" text NOT NULL,
	"user_id" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_email_reservation_members_normalized_email_user_id_pk" PRIMARY KEY("normalized_email","user_id")
);
--> statement-breakpoint
CREATE TABLE "auth_email_reservations" (
	"normalized_email" text PRIMARY KEY NOT NULL,
	"basis_projection_id" text NOT NULL,
	"state" text NOT NULL,
	"owner_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_email_reservations_state" CHECK ("auth_email_reservations"."state" IN ('owned', 'blocked_ambiguous', 'blocked_deleted', 'blocked_invalid')),
	CONSTRAINT "auth_email_reservations_owner" CHECK (("auth_email_reservations"."state" = 'owned' AND "auth_email_reservations"."owner_user_id" IS NOT NULL) OR ("auth_email_reservations"."state" <> 'owned' AND "auth_email_reservations"."owner_user_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "auth_security_mutation_events" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"generation" integer NOT NULL,
	"previous_generation" integer NOT NULL,
	"kind" text NOT NULL,
	"domains" text[] NOT NULL,
	"revoked_through" timestamp with time zone NOT NULL,
	"writer_epoch" integer NOT NULL,
	"projection_id" text NOT NULL,
	"payload_version" integer DEFAULT 1 NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_security_mutation_events_generation" CHECK ("auth_security_mutation_events"."previous_generation" >= 0 AND "auth_security_mutation_events"."generation" = "auth_security_mutation_events"."previous_generation" + 1),
	CONSTRAINT "auth_security_mutation_events_kind" CHECK ("auth_security_mutation_events"."kind" IN ('password-set', 'password-change', 'password-reset', 'account-deletion')),
	CONSTRAINT "auth_security_mutation_events_domains" CHECK ("auth_security_mutation_events"."domains" = ARRAY['first-party', 'partner']::text[]),
	CONSTRAINT "auth_security_mutation_events_epoch" CHECK ("auth_security_mutation_events"."writer_epoch" > 0 AND "auth_security_mutation_events"."payload_version" = 1)
);
--> statement-breakpoint
CREATE TABLE "auth_subject_cutoffs" (
	"user_id" text PRIMARY KEY NOT NULL,
	"generation" integer NOT NULL,
	"revoked_through" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"last_operation_id" text NOT NULL,
	CONSTRAINT "auth_subject_cutoffs_generation" CHECK ("auth_subject_cutoffs"."generation" >= 0)
);
--> statement-breakpoint
ALTER TABLE "auth_email_reservation_members" ADD CONSTRAINT "auth_email_reservation_members_normalized_email_auth_email_reservations_normalized_email_fk" FOREIGN KEY ("normalized_email") REFERENCES "public"."auth_email_reservations"("normalized_email") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_email_reservations" ADD CONSTRAINT "auth_email_reservations_basis_projection_id_auth_email_projection_projection_id_fk" FOREIGN KEY ("basis_projection_id") REFERENCES "public"."auth_email_projection"("projection_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_email_projection_current_idx" ON "auth_email_projection" USING btree ("is_current") WHERE "auth_email_projection"."is_current" = true;--> statement-breakpoint
CREATE INDEX "auth_email_reservation_members_user_idx" ON "auth_email_reservation_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_email_reservations_owner_idx" ON "auth_email_reservations" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_security_mutation_events_generation_idx" ON "auth_security_mutation_events" USING btree ("user_id","generation");