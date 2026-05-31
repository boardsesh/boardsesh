CREATE TABLE "sync_deletions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"table_name" text NOT NULL,
	"record_id" text NOT NULL,
	"user_id" text,
	"deleted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- ----------------------------------------------------------------------------
-- board_climbs / board_climb_stats sync columns — ONLINE-SAFE rework.
--
-- These two tables are the climb catalog: 200k–1M+ rows each. The plain drizzle
-- output for the two new columns was:
--   ADD COLUMN updated_at timestamp DEFAULT now() NOT NULL
--   ADD COLUMN sync_seq   bigserial NOT NULL
-- Both defaults are NON-CONSTANT (now() and nextval), so Postgres would REWRITE
-- the entire table under ACCESS EXCLUSIVE to materialise a value into every
-- existing row — a prod-deploy outage on the climb catalog.
--
-- This hand-written block (journal-registered; same precedent as 0109/0053)
-- reaches the IDENTICAL end state (`updated_at timestamp NOT NULL DEFAULT now()`,
-- `sync_seq bigint NOT NULL DEFAULT nextval(<table>_sync_seq_seq) OWNED BY col`
-- — exactly what `bigserial` produces) via the standard add-nullable → backfill
-- → set-default → set-not-null sequence, so the 0108 snapshot stays valid and a
-- later `drizzle-kit generate` sees no drift.
--
-- The sequences are named `<table>_sync_seq_seq` to match the names Postgres
-- auto-generates for `ADD COLUMN sync_seq bigserial`, keeping the end state
-- byte-identical to the un-reworked migration on DBs that already applied it.
--
-- Lock profile of each step below:
--   ADD COLUMN ... (nullable, no default)  -> metadata-only, instant.
--   CREATE SEQUENCE                          -> no table lock.
--   ALTER COLUMN ... SET DEFAULT             -> metadata-only (future rows only).
--   batched UPDATE in a DO loop              -> short lock per ~10k-row batch.
--   ALTER COLUMN ... SET NOT NULL            -> brief ACCESS EXCLUSIVE + full scan
--                                               (no rewrite); acceptable.
-- ----------------------------------------------------------------------------

-- board_climbs.updated_at / sync_seq -----------------------------------------
ALTER TABLE "board_climbs" ADD COLUMN "updated_at" timestamp;--> statement-breakpoint
ALTER TABLE "board_climbs" ADD COLUMN "sync_seq" bigint;--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "board_climbs_sync_seq_seq" AS bigint START WITH 1 INCREMENT BY 1 MINVALUE 1 NO MAXVALUE CACHE 1;--> statement-breakpoint
ALTER SEQUENCE "board_climbs_sync_seq_seq" OWNED BY "board_climbs"."sync_seq";--> statement-breakpoint
ALTER TABLE "board_climbs" ALTER COLUMN "sync_seq" SET DEFAULT nextval('board_climbs_sync_seq_seq');--> statement-breakpoint
-- Batched backfill: bounded UPDATEs so no statement holds a long lock. Each row
-- gets its own nextval (assigned in the SET, NOT via the column default, since
-- the default only fires on INSERT) and updated_at = now(). board_climbs.created_at
-- is an Aurora text column, so updated_at seeds from now() — matching 0109's
-- intent for these reference tables.
DO $$
DECLARE
  updated_rows integer;
BEGIN
  LOOP
    UPDATE "board_climbs"
    SET "sync_seq" = nextval('board_climbs_sync_seq_seq'),
        "updated_at" = now()
    WHERE "uuid" IN (
      SELECT "uuid" FROM "board_climbs"
      WHERE "sync_seq" IS NULL
      LIMIT 10000
      FOR UPDATE SKIP LOCKED
    );
    GET DIAGNOSTICS updated_rows = ROW_COUNT;
    EXIT WHEN updated_rows = 0;
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "board_climbs" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "board_climbs" ALTER COLUMN "updated_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "board_climbs" ALTER COLUMN "sync_seq" SET NOT NULL;--> statement-breakpoint

-- board_climb_stats.updated_at / sync_seq ------------------------------------
ALTER TABLE "board_climb_stats" ADD COLUMN "updated_at" timestamp;--> statement-breakpoint
ALTER TABLE "board_climb_stats" ADD COLUMN "sync_seq" bigint;--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "board_climb_stats_sync_seq_seq" AS bigint START WITH 1 INCREMENT BY 1 MINVALUE 1 NO MAXVALUE CACHE 1;--> statement-breakpoint
ALTER SEQUENCE "board_climb_stats_sync_seq_seq" OWNED BY "board_climb_stats"."sync_seq";--> statement-breakpoint
ALTER TABLE "board_climb_stats" ALTER COLUMN "sync_seq" SET DEFAULT nextval('board_climb_stats_sync_seq_seq');--> statement-breakpoint
-- Batched backfill. PK is (board_type, climb_uuid, angle); the keyset subquery
-- selects that tuple. Same per-row nextval + now() assignment as board_climbs.
DO $$
DECLARE
  updated_rows integer;
BEGIN
  LOOP
    UPDATE "board_climb_stats" AS s
    SET "sync_seq" = nextval('board_climb_stats_sync_seq_seq'),
        "updated_at" = now()
    FROM (
      SELECT "board_type", "climb_uuid", "angle" FROM "board_climb_stats"
      WHERE "sync_seq" IS NULL
      LIMIT 10000
      FOR UPDATE SKIP LOCKED
    ) AS batch
    WHERE s."board_type" = batch."board_type"
      AND s."climb_uuid" = batch."climb_uuid"
      AND s."angle" = batch."angle";
    GET DIAGNOSTICS updated_rows = ROW_COUNT;
    EXIT WHEN updated_rows = 0;
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "board_climb_stats" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "board_climb_stats" ALTER COLUMN "updated_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "board_climb_stats" ALTER COLUMN "sync_seq" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "user_favorites" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "playlist_climbs" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "user_playlist_pins" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "playlist_follows" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "setter_follows" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "user_follows" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "sync_deletions_user_since_idx" ON "sync_deletions" USING btree ("user_id","deleted_at","id");--> statement-breakpoint
CREATE INDEX "board_climb_stats_sync_cursor_idx" ON "board_climb_stats" USING btree ("updated_at","sync_seq");--> statement-breakpoint
CREATE INDEX "board_climbs_sync_cursor_idx" ON "board_climbs" USING btree ("updated_at","sync_seq");