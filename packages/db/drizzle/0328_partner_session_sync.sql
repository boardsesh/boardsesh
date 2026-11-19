CREATE TABLE "logbook_session_changes" (
	"seq" bigint PRIMARY KEY DEFAULT nextval('public.logbook_changes_seq_seq'::regclass) NOT NULL,
	"txid" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	"user_id" text NOT NULL,
	"session_export_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "logbook_snapshot_session_chunks" (
	"snapshot_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"session_export_ids" jsonb NOT NULL,
	CONSTRAINT "logbook_snapshot_session_chunks_snapshot_id_chunk_index_pk" PRIMARY KEY("snapshot_id","chunk_index")
);
--> statement-breakpoint
ALTER TABLE "board_sessions" ADD COLUMN "export_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "logbook_snapshots" ADD COLUMN "includes_sessions" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "logbook_snapshots" ADD COLUMN "ticks_complete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "logbook_snapshots" ADD COLUMN "session_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "logbook_snapshots" ADD COLUMN "session_chunk_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "logbook_snapshots" ADD COLUMN "next_session_export_id" uuid;--> statement-breakpoint
ALTER TABLE "logbook_snapshot_session_chunks" ADD CONSTRAINT "logbook_snapshot_session_chunks_snapshot_id_logbook_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."logbook_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "logbook_session_changes_user_position_idx" ON "logbook_session_changes" USING btree ("user_id","txid","seq");--> statement-breakpoint
CREATE INDEX "logbook_session_changes_global_position_idx" ON "logbook_session_changes" USING btree ("txid","seq");--> statement-breakpoint
ALTER TABLE "board_sessions" ADD CONSTRAINT "board_sessions_export_id_unique" UNIQUE("export_id");