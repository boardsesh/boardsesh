CREATE TABLE "content_privacy" (
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"owner_id" text,
	"audience" text NOT NULL,
	"public_consent_revision" integer,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "content_privacy_entity_type_entity_id_pk" PRIMARY KEY("entity_type","entity_id"),
	CONSTRAINT "content_privacy_audience_check" CHECK ("content_privacy"."audience" IN ('public', 'followers', 'only_me')),
	CONSTRAINT "content_privacy_type_check" CHECK ("content_privacy"."entity_type" IN ('tick', 'session', 'comment', 'climb', 'playlist', 'beta'))
);
--> statement-breakpoint
CREATE TABLE "resource_grants" (
	"kind" text NOT NULL,
	"resource_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"invited_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "resource_grants_kind_resource_id_user_id_pk" PRIMARY KEY("kind","resource_id","user_id"),
	CONSTRAINT "resource_grants_kind_check" CHECK ("resource_grants"."kind" IN ('board', 'session')),
	CONSTRAINT "resource_grants_status_check" CHECK ("resource_grants"."status" IN ('pending', 'approved', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "resource_privacy" (
	"kind" text NOT NULL,
	"resource_id" text NOT NULL,
	"owner_id" text,
	"audience" text NOT NULL,
	"location_audience" text DEFAULT 'only_me' NOT NULL,
	"inherit_followers" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "resource_privacy_kind_resource_id_pk" PRIMARY KEY("kind","resource_id"),
	CONSTRAINT "resource_privacy_kind_check" CHECK ("resource_privacy"."kind" IN ('board', 'session')),
	CONSTRAINT "resource_privacy_audience_check" CHECK ("resource_privacy"."audience" IN ('public', 'unlisted', 'followers', 'invite_only', 'only_me')),
	CONSTRAINT "resource_privacy_location_check" CHECK ("resource_privacy"."location_audience" IN ('public', 'followers', 'members', 'only_me'))
);
--> statement-breakpoint
CREATE TABLE "user_follow_requests" (
	"requester_id" text NOT NULL,
	"recipient_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_follow_requests_requester_id_recipient_id_pk" PRIMARY KEY("requester_id","recipient_id"),
	CONSTRAINT "user_follow_requests_not_self" CHECK ("user_follow_requests"."requester_id" <> "user_follow_requests"."recipient_id")
);
--> statement-breakpoint
ALTER TABLE "board_climbs" ADD COLUMN "is_boardsesh_authored" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "is_private" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "privacy_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "privacy_onboarding_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "default_session_audience" text;--> statement-breakpoint
ALTER TABLE "board_climb_events" ADD COLUMN "identity_policy_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "content_privacy" ADD CONSTRAINT "content_privacy_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_grants" ADD CONSTRAINT "resource_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_grants" ADD CONSTRAINT "resource_grants_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_privacy" ADD CONSTRAINT "resource_privacy_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_follow_requests" ADD CONSTRAINT "user_follow_requests_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_follow_requests" ADD CONSTRAINT "user_follow_requests_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_privacy_owner_idx" ON "content_privacy" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "resource_grants_user_idx" ON "resource_grants" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "resource_privacy_owner_idx" ON "resource_privacy" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "user_follow_requests_recipient_idx" ON "user_follow_requests" USING btree ("recipient_id","created_at");