CREATE TABLE "auth_password_change_evidence" (
	"user_id" text PRIMARY KEY NOT NULL,
	"password_fingerprint" text NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "auth_password_change_evidence_fingerprint" CHECK ("auth_password_change_evidence"."password_fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "auth_password_change_evidence" ADD CONSTRAINT "auth_password_change_evidence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;