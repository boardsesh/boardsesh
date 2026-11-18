CREATE TABLE "auth_password_guess_windows" (
	"subject_kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"window_kind" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "auth_password_guess_windows_pk" PRIMARY KEY("subject_kind","subject_key","window_kind","window_start"),
	CONSTRAINT "auth_password_guess_windows_subject_kind" CHECK ("auth_password_guess_windows"."subject_kind" IN ('email_digest', 'account_digest')),
	CONSTRAINT "auth_password_guess_windows_subject_key" CHECK ("auth_password_guess_windows"."subject_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "auth_password_guess_windows_window_kind" CHECK ("auth_password_guess_windows"."window_kind" IN ('hour', 'day')),
	CONSTRAINT "auth_password_guess_windows_failures" CHECK ("auth_password_guess_windows"."failures" >= 0)
);
--> statement-breakpoint
CREATE INDEX "auth_password_guess_windows_start_idx" ON "auth_password_guess_windows" USING btree ("window_start");