ALTER TABLE "session" ADD COLUMN "revocation_generation" integer;--> statement-breakpoint
ALTER TABLE "prototype_user_cutoff" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;