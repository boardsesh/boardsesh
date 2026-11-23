CREATE TABLE "board_merge_audit" (
	"uuid" text PRIMARY KEY NOT NULL,
	"canonical_board_uuid" text NOT NULL,
	"board_uuids" jsonb NOT NULL,
	"performed_by" text,
	"reason" text NOT NULL,
	"before_state" jsonb NOT NULL,
	"moved_counts" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "board_merge_reports" (
	"uuid" text PRIMARY KEY NOT NULL,
	"request_uuid" text NOT NULL,
	"reporter_id" text,
	"reason" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "board_merge_requests" (
	"uuid" text PRIMARY KEY NOT NULL,
	"signature" text NOT NULL,
	"board_uuids" jsonb NOT NULL,
	"canonical_board_uuid" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"reason" text NOT NULL,
	"proposer_id" text,
	"resolved_by" text,
	"resolution_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "board_merge_audit" ADD CONSTRAINT "board_merge_audit_performed_by_users_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_merge_reports" ADD CONSTRAINT "board_merge_reports_request_uuid_board_merge_requests_uuid_fk" FOREIGN KEY ("request_uuid") REFERENCES "public"."board_merge_requests"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_merge_reports" ADD CONSTRAINT "board_merge_reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_merge_requests" ADD CONSTRAINT "board_merge_requests_proposer_id_users_id_fk" FOREIGN KEY ("proposer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_merge_requests" ADD CONSTRAINT "board_merge_requests_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "board_merge_reports_request_user_idx" ON "board_merge_reports" USING btree ("request_uuid","reporter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "board_merge_requests_open_signature_idx" ON "board_merge_requests" USING btree ("signature") WHERE "board_merge_requests"."status" = 'open';--> statement-breakpoint
CREATE INDEX "board_merge_requests_status_idx" ON "board_merge_requests" USING btree ("status","created_at");