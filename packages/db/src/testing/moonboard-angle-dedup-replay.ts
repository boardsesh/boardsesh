/**
 * TEST-ONLY fixture for replaying migration 0190_moonboard_angle_dedup_backfill
 * against a scratch Postgres. Never import from production code.
 *
 * Shared by two harnesses so the replay runs BOTH in CI and locally, mirroring
 * the PR4 dedup fixture (@boardsesh/db/testing/dedup-replay):
 *  - packages/backend/src/__tests__/moonboard-angle-dedup-replay.test.ts
 *    (vitest, backend project) — runs on every CI backend job against the
 *    auto-started docker postgres; creates its own throwaway database per
 *    vitest worker.
 *  - packages/db/src/queries/climb-stats/__tests__/
 *    moonboard-angle-dedup-replay.integration.test.ts (node:test) — opt-in
 *    local scratch mode via MIGRATION_REPLAY_DB_URL.
 *
 * The dev-db image DOES carry real per-angle MoonBoard catalog duplication, so
 * `vp run db:up` exercises the grouping/merge logic at realistic scale — but it
 * has no ticks, votes, favourites or playlist rows landing on a losing member,
 * so every collision, recompute and tombstone path below is only ever covered
 * here.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type postgres from 'postgres';

/** packages/db/drizzle, resolved from this file's location. */
export const MOONBOARD_DEDUP_REPLAY_DRIZZLE_DIR = path.resolve(import.meta.dirname, '../../drizzle');

export const MOONBOARD_DEDUP_REPLAY_MIGRATION_TAG = '0190_moonboard_angle_dedup_backfill';

export function moonboardDedupReplayMigrationSql(): string {
  return readFileSync(
    path.join(MOONBOARD_DEDUP_REPLAY_DRIZZLE_DIR, `${MOONBOARD_DEDUP_REPLAY_MIGRATION_TAG}.sql`),
    'utf-8',
  );
}

/**
 * The `_bs_migration_guards` tag the migration body writes, read out of the SQL
 * rather than hardcoded.
 *
 * `vp run db:renumber` rewrites the migration's filename and every reference to
 * it in files the branch touched — including MOONBOARD_DEDUP_REPLAY_MIGRATION_TAG
 * above — but deliberately never rewrites a tag inside a migration body, because
 * on an already-merged migration that tag is an applied-once identity rather
 * than a filename (`0163_merge_moonboard_duplicates.sql` guards on
 * `0162_merge_moonboard_duplicates`). So the two can legitimately drift, and a
 * renumber silently breaking this assertion is exactly what happened once
 * already. Deriving it keeps the guard check testing the real guard.
 */
export function moonboardDedupReplayGuardTag(): string {
  const match = /_bs_migration_guards\s+\(tag\)\s+VALUES\s+\('([^']+)'\)/.exec(moonboardDedupReplayMigrationSql());
  if (!match?.[1]) {
    throw new Error('could not find the _bs_migration_guards tag in the migration body');
  }
  return match[1];
}

/**
 * MINIMAL synthetic schema — only the tables this migration touches, with just
 * the columns its SQL references. Deliberately loose on FKs/enums the real
 * schema has (this fixture never runs alongside real app code).
 *
 * The offline-sync triggers ARE ported verbatim (see the block after the
 * tables): whether this migration is safe for mobile clients is entirely a
 * question of which sync_deletions rows get written and which (updated_at,
 * sync_seq) cursors move, and a fixture without those triggers would assert
 * none of it.
 */
export const MOONBOARD_DEDUP_REPLAY_SCHEMA_SQL = `
  CREATE TYPE social_entity_type AS ENUM ('climb', 'tick', 'comment');

  CREATE TABLE board_climbs (
    uuid text PRIMARY KEY,
    board_type text NOT NULL,
    layout_id integer NOT NULL,
    angle integer,
    user_id text,
    is_draft boolean NOT NULL DEFAULT false,
    is_listed boolean,
    created_at text,
    updated_at timestamp NOT NULL DEFAULT now(),
    sync_seq bigserial NOT NULL
  );

  CREATE TABLE board_climb_holds (
    board_type text NOT NULL,
    climb_uuid text NOT NULL REFERENCES board_climbs(uuid) ON UPDATE CASCADE ON DELETE CASCADE,
    hold_id integer NOT NULL,
    frame_number integer NOT NULL DEFAULT 1,
    hold_state text NOT NULL,
    PRIMARY KEY (board_type, climb_uuid, hold_id)
  );

  -- Column-for-column mirror of boardClimbStats (packages/db/src/schema/
  -- boards/unified.ts). boardsesh_quality_sum / boardsesh_quality_count and
  -- updated_at / sync_seq are NOT optional here: the first pair is the quality
  -- blend's Boardsesh numerator and weight (an earlier version of the
  -- migration silently nulled them on every re-keyed row), and the second is
  -- what carries a changed row to offline clients.
  CREATE TABLE board_climb_stats (
    board_type text NOT NULL,
    climb_uuid text NOT NULL,
    angle integer NOT NULL,
    display_difficulty double precision,
    benchmark_difficulty double precision,
    ascensionist_count bigint,
    upstream_ascensionist_count bigint,
    boardsesh_ascensionist_count bigint,
    difficulty_average double precision,
    quality_average double precision,
    upstream_quality_average double precision,
    boardsesh_quality_sum double precision,
    boardsesh_quality_count bigint,
    quality_normalized boolean NOT NULL DEFAULT false,
    fa_username text,
    fa_at timestamp,
    upstream_synced_at timestamp,
    updated_at timestamp NOT NULL DEFAULT now(),
    sync_seq bigserial NOT NULL,
    PRIMARY KEY (board_type, climb_uuid, angle)
  );

  -- Only ever a defensive no-op for MoonBoard (step 5c), but the migration
  -- names the table, so it has to exist for the SQL to parse.
  CREATE TABLE board_climb_grades (
    board_type text NOT NULL,
    climb_uuid text NOT NULL,
    angle integer NOT NULL,
    universal_grade double precision,
    computed_at timestamp NOT NULL DEFAULT now(),
    PRIMARY KEY (board_type, climb_uuid, angle)
  );

  -- The offline tombstone log. Rows land here from the ported delete triggers
  -- below and from the migration's own hand-written inserts for repointed
  -- rows whose CLIENT primary key moved.
  CREATE TABLE sync_deletions (
    id bigserial PRIMARY KEY,
    table_name text NOT NULL,
    record_id text NOT NULL,
    user_id text,
    deleted_at timestamp NOT NULL DEFAULT now()
  );

  CREATE TABLE board_climb_stats_history (
    id bigserial PRIMARY KEY,
    board_type text NOT NULL,
    climb_uuid text NOT NULL,
    angle integer NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE board_climb_aliases (
    board_type text NOT NULL,
    alias_uuid text NOT NULL,
    canonical_uuid text NOT NULL REFERENCES board_climbs(uuid) ON UPDATE CASCADE ON DELETE CASCADE,
    source text NOT NULL,
    first_seen_at timestamp DEFAULT now() NOT NULL,
    last_seen_at timestamp DEFAULT now() NOT NULL,
    PRIMARY KEY (board_type, alias_uuid)
  );

  -- Mirrors the columns recomputeClimbStatsBulk() reads (packages/db/src/
  -- queries/climb-stats/recompute.ts), which step 3b of the migration ports:
  -- origin/status decide who counts, quality/climbed_at/id decide whose rating
  -- is the climber's current one, and the kilter_* trio drives the
  -- "already absorbed into the upstream count" exclusion.
  CREATE TABLE boardsesh_ticks (
    id bigserial PRIMARY KEY,
    uuid text NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
    user_id text NOT NULL,
    board_type text NOT NULL,
    climb_uuid text NOT NULL,
    angle integer NOT NULL,
    origin text NOT NULL DEFAULT 'native',
    status text NOT NULL DEFAULT 'send',
    quality integer,
    climbed_at timestamp NOT NULL DEFAULT now(),
    kilter_id text,
    kilter_synced_at timestamp,
    kilter_detached_at timestamp,
    updated_at timestamp NOT NULL DEFAULT now()
  );

  CREATE TABLE board_climb_events (
    id bigserial PRIMARY KEY,
    board_type text NOT NULL,
    climb_uuid text NOT NULL
  );

  CREATE TABLE climb_proposals (
    id bigserial PRIMARY KEY,
    climb_uuid text NOT NULL,
    board_type text NOT NULL,
    angle integer
  );

  CREATE TABLE comments (
    id bigserial PRIMARY KEY,
    entity_type social_entity_type NOT NULL,
    entity_id text NOT NULL
  );

  CREATE TABLE feed_items (
    id bigserial PRIMARY KEY,
    entity_type social_entity_type NOT NULL,
    entity_id text NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE notifications (
    id bigserial PRIMARY KEY,
    entity_type social_entity_type,
    entity_id text
  );

  -- playlists / playlist_ownership exist only because the playlist_climbs
  -- tombstone key is '<playlist UUID>:<climb uuid>' scoped to the playlist
  -- OWNER — the migration has to resolve both, exactly like the trigger does.
  CREATE TABLE playlists (
    id bigserial PRIMARY KEY,
    uuid text NOT NULL UNIQUE
  );

  CREATE TABLE playlist_ownership (
    playlist_id bigint NOT NULL,
    user_id text NOT NULL,
    role text NOT NULL,
    PRIMARY KEY (playlist_id, user_id)
  );

  CREATE TABLE playlist_climbs (
    id bigserial PRIMARY KEY,
    playlist_id bigint NOT NULL,
    climb_uuid text NOT NULL,
    angle integer,
    position integer NOT NULL DEFAULT 0,
    added_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    UNIQUE (playlist_id, climb_uuid)
  );

  CREATE TABLE board_circuits_climbs (
    board_type text NOT NULL,
    circuit_uuid text NOT NULL,
    climb_uuid text NOT NULL,
    position integer,
    PRIMARY KEY (board_type, circuit_uuid, climb_uuid)
  );

  CREATE TABLE climb_classic_status (
    id bigserial PRIMARY KEY,
    climb_uuid text NOT NULL,
    board_type text NOT NULL,
    is_classic boolean NOT NULL DEFAULT false,
    updated_at timestamp NOT NULL DEFAULT now(),
    UNIQUE (climb_uuid, board_type)
  );

  CREATE TABLE board_beta_links (
    board_type text NOT NULL,
    climb_uuid text NOT NULL,
    link text NOT NULL,
    angle integer,
    tick_uuid text,
    created_at text,
    PRIMARY KEY (board_type, climb_uuid, link)
  );

  CREATE TABLE user_favorites (
    id bigserial PRIMARY KEY,
    user_id text NOT NULL,
    board_name text NOT NULL,
    climb_uuid text NOT NULL,
    angle integer NOT NULL,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    UNIQUE (user_id, board_name, climb_uuid, angle)
  );

  CREATE TABLE climb_community_status (
    id bigserial PRIMARY KEY,
    climb_uuid text NOT NULL,
    board_type text NOT NULL,
    angle integer NOT NULL,
    community_grade text,
    updated_at timestamp NOT NULL DEFAULT now(),
    last_proposal_id bigint,
    UNIQUE (climb_uuid, board_type, angle)
  );

  CREATE TABLE board_climb_ratings (
    id bigserial PRIMARY KEY,
    board_type text NOT NULL,
    climb_uuid text NOT NULL,
    angle integer NOT NULL,
    user_id text NOT NULL,
    rating integer,
    UNIQUE (board_type, climb_uuid, angle, user_id)
  );

  CREATE TABLE votes (
    id bigserial PRIMARY KEY,
    user_id text NOT NULL,
    entity_type social_entity_type NOT NULL,
    entity_id text NOT NULL,
    value integer NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL,
    UNIQUE (user_id, entity_type, entity_id)
  );

  CREATE TABLE vote_counts (
    entity_type social_entity_type NOT NULL,
    entity_id text NOT NULL,
    upvotes integer NOT NULL DEFAULT 0,
    downvotes integer NOT NULL DEFAULT 0,
    score integer NOT NULL DEFAULT 0,
    hot_score double precision NOT NULL DEFAULT 0,
    created_at timestamp NOT NULL,
    PRIMARY KEY (entity_type, entity_id)
  );

  CREATE TABLE board_climb_embeddings (
    board_type text NOT NULL,
    climb_uuid text NOT NULL,
    angle integer NOT NULL,
    PRIMARY KEY (board_type, climb_uuid, angle)
  );

  CREATE TABLE board_climb_similar (
    board_type text NOT NULL,
    climb_uuid text NOT NULL,
    angle integer NOT NULL,
    neighbor_uuid text NOT NULL,
    PRIMARY KEY (board_type, climb_uuid, angle, neighbor_uuid)
  );

  CREATE TABLE board_climb_send_stats (
    board_type text NOT NULL,
    climb_uuid text NOT NULL,
    send_count_30d integer NOT NULL DEFAULT 0,
    sender_count_30d integer NOT NULL DEFAULT 0,
    send_count_90d integer NOT NULL DEFAULT 0,
    last_sent_at timestamp,
    updated_at timestamp DEFAULT now() NOT NULL,
    PRIMARY KEY (board_type, climb_uuid)
  );

  -- The REAL votes_count_trigger, verbatim from 0130_vote_count_skip_guard.sql
  -- (re-creates 0053_add_vote_counts.sql's function with the skip guard added).
  -- Deliberately included (not omitted, as an earlier version of this fixture
  -- did) so the replay actually exercises the trigger interplay migration
  -- this migration's votes/vote_counts steps depend on — that's exactly
  -- where an earlier version of it had a formula mismatch with this trigger.
  CREATE OR REPLACE FUNCTION update_vote_counts() RETURNS trigger AS $$
  DECLARE
    v_entity_type social_entity_type;
    v_entity_id text;
    v_up int;
    v_down int;
    v_score int;
    v_hot_score double precision;
    v_created_at timestamp;
  BEGIN
    IF current_setting('boardsesh.skip_vote_counts', true) = 'on' THEN
      RETURN NULL;
    END IF;

    IF TG_OP = 'DELETE' THEN
      v_entity_type := OLD.entity_type;
      v_entity_id := OLD.entity_id;
    ELSE
      v_entity_type := NEW.entity_type;
      v_entity_id := NEW.entity_id;
    END IF;

    SELECT
      COALESCE(SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END), 0)
    INTO v_up, v_down
    FROM votes
    WHERE entity_type = v_entity_type AND entity_id = v_entity_id;

    v_score := v_up - v_down;

    SELECT COALESCE(
      (SELECT fi."created_at" FROM feed_items fi
       WHERE fi."entity_type" = v_entity_type AND fi."entity_id" = v_entity_id
       LIMIT 1),
      NOW()
    ) INTO v_created_at;

    v_hot_score := SIGN(v_score) * LN(GREATEST(ABS(v_score), 1))
      + EXTRACT(EPOCH FROM v_created_at) / 45000.0;

    INSERT INTO vote_counts (entity_type, entity_id, upvotes, downvotes, score, hot_score, created_at)
    VALUES (v_entity_type, v_entity_id, v_up, v_down, v_score, v_hot_score, v_created_at)
    ON CONFLICT (entity_type, entity_id) DO UPDATE SET
      upvotes = EXCLUDED.upvotes,
      downvotes = EXCLUDED.downvotes,
      score = EXCLUDED.score,
      hot_score = EXCLUDED.hot_score;

    IF v_up = 0 AND v_down = 0 THEN
      DELETE FROM vote_counts WHERE entity_type = v_entity_type AND entity_id = v_entity_id;
    END IF;

    RETURN NULL;
  END;
  $$ LANGUAGE plpgsql;

  CREATE TRIGGER votes_count_trigger
    AFTER INSERT OR UPDATE OR DELETE ON votes
    FOR EACH ROW EXECUTE FUNCTION update_vote_counts();

  -- ── Offline-sync triggers, ported verbatim from 0144/0146/0147 ───────────
  -- Everything a mobile client learns about this migration arrives through
  -- these: a DELETE has to leave a sync_deletions tombstone in the exact
  -- record_id format the client parses, and an UPDATE has to move a cursor.
  -- Without them the replay would happily "pass" a migration that silently
  -- stranded a row on every device.

  -- 0144: log_deletion_favorites / trg_favorites_delete.
  CREATE OR REPLACE FUNCTION log_deletion_favorites() RETURNS TRIGGER AS $$
  BEGIN
    INSERT INTO sync_deletions (table_name, record_id, user_id)
    VALUES (TG_TABLE_NAME, OLD.board_name || ':' || OLD.climb_uuid || ':' || OLD.angle::text, OLD.user_id);
    RETURN OLD;
  END;
  $$ LANGUAGE plpgsql;

  CREATE TRIGGER trg_favorites_delete AFTER DELETE ON user_favorites
    FOR EACH ROW EXECUTE FUNCTION log_deletion_favorites();

  -- 0146 (supersedes 0144): log_deletion_playlist_climbs. Note the key is the
  -- playlist's UUID, not its id, and both early-return guards are real.
  CREATE OR REPLACE FUNCTION log_deletion_playlist_climbs() RETURNS TRIGGER AS $$
  DECLARE
    v_playlist_uuid text;
    owner_id text;
  BEGIN
    SELECT p.uuid INTO v_playlist_uuid FROM playlists p WHERE p.id = OLD.playlist_id LIMIT 1;
    IF v_playlist_uuid IS NULL THEN
      RETURN OLD;
    END IF;

    SELECT po.user_id INTO owner_id
      FROM playlist_ownership po
     WHERE po.playlist_id = OLD.playlist_id AND po.role = 'owner'
     LIMIT 1;
    IF owner_id IS NULL THEN
      RETURN OLD;
    END IF;

    INSERT INTO sync_deletions (table_name, record_id, user_id)
    VALUES (TG_TABLE_NAME, v_playlist_uuid || ':' || OLD.climb_uuid, owner_id);
    RETURN OLD;
  END;
  $$ LANGUAGE plpgsql;

  CREATE TRIGGER trg_playlist_climbs_delete AFTER DELETE ON playlist_climbs
    FOR EACH ROW EXECUTE FUNCTION log_deletion_playlist_climbs();

  -- 0144: log_deletion_board_climb_stats. The suppress guard is included so
  -- the replay proves the migration does NOT set it — a migration that did
  -- would delete alias stats rows with no tombstone at all.
  CREATE OR REPLACE FUNCTION log_deletion_board_climb_stats() RETURNS TRIGGER AS $$
  BEGIN
    IF current_setting('boardsesh.suppress_sync_tombstones', true) = 'on' THEN
      RETURN OLD;
    END IF;
    INSERT INTO sync_deletions (table_name, record_id, user_id)
    VALUES (TG_TABLE_NAME, OLD.board_type || ':' || OLD.climb_uuid || ':' || OLD.angle::text, NULL);
    RETURN OLD;
  END;
  $$ LANGUAGE plpgsql;

  CREATE TRIGGER trg_board_climb_stats_delete AFTER DELETE ON board_climb_stats
    FOR EACH ROW EXECUTE FUNCTION log_deletion_board_climb_stats();

  -- 0144: log_deletion_ticks.
  CREATE OR REPLACE FUNCTION log_deletion_ticks() RETURNS TRIGGER AS $$
  BEGIN
    INSERT INTO sync_deletions (table_name, record_id, user_id)
    VALUES (TG_TABLE_NAME, OLD.uuid, OLD.user_id);
    RETURN OLD;
  END;
  $$ LANGUAGE plpgsql;

  CREATE TRIGGER trg_ticks_delete AFTER DELETE ON boardsesh_ticks
    FOR EACH ROW EXECUTE FUNCTION log_deletion_ticks();

  -- 0144/0146: the cursor stampers. These are how a repointed or delisted row
  -- reaches a device at all, and why the migration must never hand-write
  -- updated_at / sync_seq.
  CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
  BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE TRIGGER trg_user_favorites_set_updated_at BEFORE UPDATE ON user_favorites
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  CREATE TRIGGER trg_playlist_climbs_set_updated_at BEFORE UPDATE ON playlist_climbs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  CREATE TRIGGER trg_boardsesh_ticks_set_updated_at BEFORE UPDATE ON boardsesh_ticks
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

  CREATE OR REPLACE FUNCTION set_board_climbs_sync_fields() RETURNS TRIGGER AS $$
  BEGIN
    NEW.updated_at = NOW();
    NEW.sync_seq = nextval('board_climbs_sync_seq_seq');
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE TRIGGER trg_board_climbs_set_sync_fields BEFORE UPDATE ON board_climbs
    FOR EACH ROW
    WHEN ((to_jsonb(OLD) - ARRAY['updated_at','sync_seq']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updated_at','sync_seq']))
    EXECUTE FUNCTION set_board_climbs_sync_fields();

  CREATE OR REPLACE FUNCTION set_board_climb_stats_sync_fields() RETURNS TRIGGER AS $$
  BEGIN
    NEW.updated_at = NOW();
    NEW.sync_seq = nextval('board_climb_stats_sync_seq_seq');
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE TRIGGER trg_board_climb_stats_set_sync_fields BEFORE UPDATE ON board_climb_stats
    FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*)
    EXECUTE FUNCTION set_board_climb_stats_sync_fields();
`;

/**
 * Seed covers six cases:
 *  - CASE A ("p25"/"p40"): the expected shape — one problem graded at two
 *    distinct angles, exercising every repoint/collision/merge path plus the
 *    offline tombstones a repoint owes.
 *  - CASE B ("q25a"/"q25b"): a same-angle collision (both members at 25°) —
 *    must be left completely untouched.
 *  - CASE C ("r25"/"r30u"): a catalog row and a user-owned row that happen to
 *    share holds+angle — the user-owned row must never be touched.
 *  - CASE D ("t25"/"t40"/"t55"): a 3-angle group, proving the migration
 *    handles arbitrary group sizes, not just pairs.
 *  - CASE E ("w25"/"w40"/"w55"): a 3-angle group where two NON-CANONICAL
 *    members collide with EACH OTHER (not just with the canonical) across
 *    playlist/circuit/classic-status/beta-link/community-status/favourite/vote
 *    rows — reproduces a real bug where a canonical-only collision check
 *    missed alias-vs-alias collisions and aborted the whole migration on
 *    deploy, and pins the survivor policy for each of those tables.
 *  - CASE F ("s25"/"s40"): real tick history on BOTH members at the same
 *    angle, including one climber who ticked both — the case where merging
 *    the stored counts arithmetically is wrong however you do it, and only a
 *    recount from the repointed ticks lands on the right number.
 */
export const MOONBOARD_DEDUP_REPLAY_SEED_SQL = `
  INSERT INTO playlists (id, uuid) VALUES (100, 'playlist-a-uuid'), (300, 'playlist-e-uuid');
  INSERT INTO playlist_ownership (playlist_id, user_id, role) VALUES
    (100, 'u1', 'owner'), (300, 'u7', 'owner');

  -- CASE A: problem P, graded at 25° (fewer ascents) and 40° (more ascents,
  -- so it wins canonical selection).
  INSERT INTO board_climbs (uuid, board_type, layout_id, angle, user_id, is_draft, is_listed, created_at) VALUES
    ('p25', 'moonboard', 1, 25, NULL, false, true, '2024-01-01T00:00:00Z'),
    ('p40', 'moonboard', 1, 40, NULL, false, true, '2023-06-01T00:00:00Z');

  INSERT INTO board_climb_holds (board_type, climb_uuid, hold_id, hold_state) VALUES
    ('moonboard','p25',1,'STARTING'), ('moonboard','p25',2,'FINISH'),
    ('moonboard','p40',1,'STARTING'), ('moonboard','p40',2,'FINISH');

  -- Realistic post-0167 shape: every non-owned row carries
  -- upstream_quality_average alongside the materialized quality_average, and
  -- ascensionist_count is already upstream + boardsesh.
  INSERT INTO board_climb_stats (board_type, climb_uuid, angle, ascensionist_count, upstream_ascensionist_count,
         boardsesh_ascensionist_count, quality_average, upstream_quality_average) VALUES
    ('moonboard','p25',25,6,5,1,3.5,3.5),
    ('moonboard','p40',40,21,20,1,4.2,4.2);

  -- Realistic pre-migration alias state: the catalog importer already wrote
  -- p25 a self-alias (every catalog climb gets one on ingest — see PR #3851),
  -- AND a pre-existing alias from an earlier, unrelated merge (e.g. the
  -- importer's own id-based-uuid-vs-legacy-uuid aliasing) already points at
  -- p25 too. Step 1 must: (a) hit the ON CONFLICT DO UPDATE branch for p25's
  -- own row (repointing canonical_uuid to p40 without touching source — the
  -- plain-INSERT path alone is never exercised in prod), and (b) repoint the
  -- OTHER alias straight to p40 rather than leaving a two-hop chain through a
  -- now-delisted row.
  INSERT INTO board_climb_aliases (board_type, alias_uuid, canonical_uuid, source) VALUES
    ('moonboard', 'p25', 'p25', 'moonboard-catalog-import'),
    ('moonboard', 'p25-prior-alias', 'p25', 'moonboard-catalog-import');

  INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, climbed_at) VALUES
    ('tick-p25-u1','u1','moonboard','p25',25,'2024-03-01T00:00:00Z'),
    ('tick-p40-u1','u1','moonboard','p40',40,'2024-03-02T00:00:00Z');

  -- user_favorites. u1's two rows sit at different angles, so they don't
  -- collide — but repointing p25@25 onto p40@25 still MOVES the row's client
  -- primary key (board_name:climb_uuid:angle) and fires no delete trigger, so
  -- the migration owes a hand-written tombstone for 'moonboard:p25:25'.
  -- u9 holds a genuine same-angle collision at 40° (a favourite on the alias
  -- at a non-native angle plus one on the canonical): the canonical's own row
  -- survives physically, taking u9's EARLIEST created_at with it.
  INSERT INTO user_favorites (user_id, board_name, climb_uuid, angle, created_at) VALUES
    ('u1','moonboard','p25',25,'2024-01-05T00:00:00Z'),
    ('u1','moonboard','p40',40,'2024-01-06T00:00:00Z'),
    ('u9','moonboard','p25',40,'2023-02-01T00:00:00Z'),
    ('u9','moonboard','p40',40,'2024-09-01T00:00:00Z');

  INSERT INTO climb_community_status (climb_uuid, board_type, angle, community_grade) VALUES
    ('p25','moonboard',25,'V4'), ('p40','moonboard',40,'V6');

  -- climb_classic_status: only the alias (p25) has a row — a plain repoint,
  -- no collision, since the canonical (p40) starts with none.
  INSERT INTO climb_classic_status (climb_uuid, board_type, is_classic) VALUES
    ('p25','moonboard',true);

  -- playlist_climbs: BOTH p25 and p40 are in the same playlist -> collision.
  -- p25 was added FIRST and sits earlier in the list, so the earliest-wins
  -- policy hands its added_at/position to the surviving canonical row.
  INSERT INTO playlist_climbs (playlist_id, climb_uuid, position, added_at) VALUES
    (100, 'p25', 2, '2023-11-01T00:00:00Z'),
    (100, 'p40', 9, '2024-08-01T00:00:00Z');

  -- board_circuits_climbs: BOTH in the same circuit -> collision. p25 sits
  -- earlier in the circuit, so the lowest-position policy keeps its row.
  INSERT INTO board_circuits_climbs (board_type, circuit_uuid, climb_uuid, position) VALUES
    ('moonboard','circuit-1','p25',1), ('moonboard','circuit-1','p40',8);

  -- board_beta_links: same link on both -> collision. The canonical's own row
  -- wins outright here, even though the alias's is tied to a specific ascent.
  INSERT INTO board_beta_links (board_type, climb_uuid, link, angle, tick_uuid, created_at) VALUES
    ('moonboard','p25','https://example.com/beta',25,'tick-p25-u1','2024-01-01T00:00:00Z'),
    ('moonboard','p40','https://example.com/beta',40,NULL,'2024-05-01T00:00:00Z');

  -- votes: u2 only on p25, u3 only on p40 (no collision); u4 on BOTH
  -- (collision). u4's vote on the ALIAS is the newer one and flips sign, so
  -- the latest-wins policy is directly observable: an implementation that
  -- keeps the canonical's own row (as an earlier version did) leaves u4 at
  -- +1 and lands vote_counts on 2/1/+1 instead of 1/2/-1.
  -- Seeded with the trigger suppressed so pre-migration vote_counts land at
  -- these exact, deterministic values regardless of trigger timing/ordering —
  -- the migration's OWN rebuild (step 6) is what's under test, not the seed.
  SELECT set_config('boardsesh.skip_vote_counts', 'on', false);
  INSERT INTO votes (user_id, entity_type, entity_id, value, created_at) VALUES
    ('u2','climb','p25',1,'2024-02-01T00:00:00Z'),
    ('u3','climb','p40',-1,'2024-02-01T00:00:00Z'),
    ('u4','climb','p40',1,'2024-02-01T00:00:00Z'),
    ('u4','climb','p25',-1,'2024-07-01T00:00:00Z');
  INSERT INTO vote_counts (entity_type, entity_id, upvotes, downvotes, score, hot_score, created_at) VALUES
    ('climb','p25',2,0,2,1.0,'2024-01-15T00:00:00Z'),
    ('climb','p40',1,0,1,1.0,'2024-06-01T00:00:00Z');
  SELECT set_config('boardsesh.skip_vote_counts', 'off', false);

  INSERT INTO board_climb_embeddings (board_type, climb_uuid, angle) VALUES ('moonboard','p25',25);
  INSERT INTO board_climb_similar (board_type, climb_uuid, angle, neighbor_uuid) VALUES
    ('moonboard','p25',25,'other-climb'), ('moonboard','other-climb',40,'p25');

  INSERT INTO board_climb_send_stats (board_type, climb_uuid, send_count_30d, sender_count_30d, send_count_90d, last_sent_at) VALUES
    ('moonboard','p25',3,2,5,'2024-03-01T00:00:00Z'),
    ('moonboard','p40',7,4,9,'2024-04-01T00:00:00Z');

  INSERT INTO board_climb_stats_history (board_type, climb_uuid, angle) VALUES ('moonboard','p25',25);
  INSERT INTO board_climb_events (board_type, climb_uuid) VALUES ('moonboard','p25');
  INSERT INTO climb_proposals (climb_uuid, board_type, angle) VALUES ('p25','moonboard',25);
  INSERT INTO comments (entity_type, entity_id) VALUES ('climb','p25');
  -- feed_items.created_at feeds the vote_counts rebuild's hot_score/created_at
  -- chain (step 6): both rows get repointed onto p40 by step 3's plain
  -- repoint, so the rebuild's "earliest feed_items row" pick is exercised
  -- (p25's earlier row must win over p40's own later one).
  INSERT INTO feed_items (entity_type, entity_id, created_at) VALUES
    ('climb','p25','2024-01-15T00:00:00Z'),
    ('climb','p40','2024-06-01T00:00:00Z');
  INSERT INTO notifications (entity_type, entity_id) VALUES ('climb','p25');

  -- CASE D: problem T, graded at THREE distinct angles (25°, 40°, 55°) — the
  -- migration is written to handle arbitrary group sizes, not just pairs;
  -- this exercises canonical selection among 3 candidates and a 3-row
  -- (not 2-row) stats/ticks repoint.
  INSERT INTO board_climbs (uuid, board_type, layout_id, angle, user_id, is_draft, is_listed, created_at) VALUES
    ('t25', 'moonboard', 1, 25, NULL, false, true, '2024-01-01T00:00:00Z'),
    ('t40', 'moonboard', 1, 40, NULL, false, true, '2024-01-02T00:00:00Z'),
    ('t55', 'moonboard', 1, 55, NULL, false, true, '2024-01-03T00:00:00Z');
  INSERT INTO board_climb_holds (board_type, climb_uuid, hold_id, hold_state) VALUES
    ('moonboard','t25',30,'STARTING'), ('moonboard','t25',31,'FINISH'),
    ('moonboard','t40',30,'STARTING'), ('moonboard','t40',31,'FINISH'),
    ('moonboard','t55',30,'STARTING'), ('moonboard','t55',31,'FINISH');
  -- ascensionist_count is seeded as the true upstream + boardsesh total on
  -- every row in this fixture, so the global invariant check at the bottom is
  -- a real assertion about the migration rather than about the seed.
  INSERT INTO board_climb_stats (board_type, climb_uuid, angle, ascensionist_count,
         upstream_ascensionist_count, boardsesh_ascensionist_count) VALUES
    ('moonboard','t25',25,3,3,0),
    ('moonboard','t40',40,50,50,0),
    ('moonboard','t55',55,7,7,0);
  INSERT INTO boardsesh_ticks (user_id, board_type, climb_uuid, angle) VALUES
    ('u5','moonboard','t25',25), ('u5','moonboard','t40',40), ('u5','moonboard','t55',55);

  -- CASE E: problem W, graded at THREE distinct angles (25°/40°/55°, canonical
  -- w40) — same shape as CASE D, but with TWO NON-CANONICAL members (w25,
  -- w55) both holding a row in the same collision-prone table. This
  -- reproduces a real bug: dedupe steps that only checked "does this alias's
  -- row collide with the CANONICAL's own row" miss two ALIASES colliding
  -- with EACH OTHER once both repoint onto the same canonical, and the whole
  -- migration aborted with a unique-constraint violation. If this seed makes
  -- prepareMoonboardDedupReplayDatabase() throw, that alone is the strongest
  -- possible regression signal — every test in this file would fail with the
  -- same setup error.
  INSERT INTO board_climbs (uuid, board_type, layout_id, angle, user_id, is_draft, is_listed, created_at) VALUES
    ('w25', 'moonboard', 1, 25, NULL, false, true, '2024-01-01T00:00:00Z'),
    ('w40', 'moonboard', 1, 40, NULL, false, true, '2024-01-02T00:00:00Z'),
    ('w55', 'moonboard', 1, 55, NULL, false, true, '2024-01-03T00:00:00Z');
  INSERT INTO board_climb_holds (board_type, climb_uuid, hold_id, hold_state) VALUES
    ('moonboard','w25',40,'STARTING'), ('moonboard','w25',41,'FINISH'),
    ('moonboard','w40',40,'STARTING'), ('moonboard','w40',41,'FINISH'),
    ('moonboard','w55',40,'STARTING'), ('moonboard','w55',41,'FINISH');
  INSERT INTO board_climb_stats (board_type, climb_uuid, angle, ascensionist_count,
         upstream_ascensionist_count, boardsesh_ascensionist_count) VALUES
    ('moonboard','w25',25,3,3,0),
    ('moonboard','w40',40,50,50,0),
    ('moonboard','w55',55,7,7,0);

  -- Every collision below is between the two ALIASES (w25/w55), never with the
  -- canonical, and each pair is seeded so the LOSER is the one a naive
  -- "lowest id/ctid wins" tiebreak would have kept. That makes the survivor
  -- policy observable rather than merely deterministic: w25 is always
  -- inserted first, so every assertion that expects w55's values would fail
  -- against the old arbitrary tiebreak.

  -- playlist_climbs: w25 AND w55 (NOT w40) both in playlist 300 — collision
  -- between two aliases, canonical has no row there at all. w55 was added
  -- first and sits earlier in the list.
  INSERT INTO playlist_climbs (playlist_id, climb_uuid, position, added_at) VALUES
    (300, 'w25', 11, '2024-06-01T00:00:00Z'),
    (300, 'w55', 3, '2023-01-01T00:00:00Z');

  -- board_circuits_climbs: same shape; w55 sits earlier in the circuit.
  INSERT INTO board_circuits_climbs (board_type, circuit_uuid, climb_uuid, position) VALUES
    ('moonboard','circuit-2','w25',12), ('moonboard','circuit-2','w55',4);

  -- climb_classic_status: unique on (climb_uuid, board_type) only — no angle
  -- discriminator at all, so this collides even without matching angles.
  -- w55 carries the stronger signal (the community said classic; w25's row
  -- says it isn't), so it survives even though w25's row is older.
  INSERT INTO climb_classic_status (climb_uuid, board_type, is_classic) VALUES
    ('w25','moonboard',false), ('w55','moonboard',true);

  -- board_beta_links: same link on both aliases. w55's beta is tied to a real
  -- ascent, w25's is loose, so w55 wins on signal strength.
  INSERT INTO board_beta_links (board_type, climb_uuid, link, angle, tick_uuid, created_at) VALUES
    ('moonboard','w25','https://example.com/w-beta',25,NULL,'2023-01-01T00:00:00Z'),
    ('moonboard','w55','https://example.com/w-beta',55,'tick-w','2024-01-01T00:00:00Z');

  -- climb_community_status: both aliases graded at 55° — a same-angle
  -- collision between two aliases. w25's row carries the newer community
  -- decision (a higher last_proposal_id), so it is the one that survives.
  -- w55's row is inserted FIRST so it holds the lower id: the strongest-signal
  -- policy must pick w25's newer proposal in spite of that, not because of it.
  INSERT INTO climb_community_status (climb_uuid, board_type, angle, community_grade, updated_at, last_proposal_id) VALUES
    ('w55','moonboard',55,'V5','2023-01-01T00:00:00Z',12),
    ('w25','moonboard',55,'V8','2024-09-01T00:00:00Z',77);

  -- user_favorites: u7 starred both aliases at 25° — a same-angle collision
  -- with no canonical row, so the policy winner survives and carries the
  -- EARLIEST created_at. Both keys it vacates need a tombstone: w25's from
  -- the delete trigger, w55's hand-written by the migration.
  INSERT INTO user_favorites (user_id, board_name, climb_uuid, angle, created_at) VALUES
    ('u7','moonboard','w25',25,'2024-10-01T00:00:00Z'),
    ('u7','moonboard','w55',25,'2022-05-01T00:00:00Z');

  -- votes: u7 votes on BOTH w25 and w55 — collision. w55's is the LATER vote
  -- and flips the sign, so latest-wins makes w40 end up negative. Trigger left
  -- ACTIVE here (no skip_vote_counts guard): w25/w55's own pre-migration
  -- vote_counts values aren't asserted, only w40's post-migration state, which
  -- step 6 fully rebuilds from scratch regardless of what existed before.
  INSERT INTO votes (user_id, entity_type, entity_id, value, created_at) VALUES
    ('u7','climb','w25',1,'2024-02-01T00:00:00Z'),
    ('u7','climb','w55',-1,'2024-08-02T00:00:00Z');

  -- CASE F: problem S, graded at 25° and 40° (canonical s40), with real tick
  -- history at 40° on BOTH members — the case no row-level arithmetic can get
  -- right. boardsesh_ascensionist_count counts DISTINCT climbers:
  --   u10 ticked BOTH s25 and s40 at 40°  -> ONE ascensionist after the merge
  --   u11 ticked only s25 at 40°
  --   u12 ticked only s40 at 40°
  -- so the answer is 3. A naive SUM of the two stored counts gives 4 (u10
  -- double-counted); a naive GREATEST gives 2 (u11 or u12 dropped). Only
  -- recounting from the repointed ticks lands on 3, which is why step 3b
  -- exists. The stored counts below are deliberately seeded to the values a
  -- correct pre-merge system would hold (s25@40: u10+u11 = 2, s40@40: u10+u12
  -- = 2), so both naive merges are wrong by construction.
  --
  -- Quality follows the same rule per climber — LATEST rated native
  -- flash/send tick wins (max climbed_at, tie max id):
  --   u10: 2 on s25 (Jan) vs 5 on s40 (Jun) -> 5
  --   u11: 3, u12: 4
  -- so sum 12 over 3 climbers. With no upstream quality on the 40° row the
  -- blend collapses to that plain average, 4.0.
  --
  -- s25's own 25° row has upstream quality and NO ticks, so it re-blends back
  -- to exactly its upstream average — the "don't disturb what you didn't
  -- merge" half of the same assertion.
  INSERT INTO board_climbs (uuid, board_type, layout_id, angle, user_id, is_draft, is_listed, created_at) VALUES
    ('s25', 'moonboard', 1, 25, NULL, false, true, '2024-01-01T00:00:00Z'),
    ('s40', 'moonboard', 1, 40, NULL, false, true, '2024-01-02T00:00:00Z');
  INSERT INTO board_climb_holds (board_type, climb_uuid, hold_id, hold_state) VALUES
    ('moonboard','s25',50,'STARTING'), ('moonboard','s25',51,'FINISH'),
    ('moonboard','s40',50,'STARTING'), ('moonboard','s40',51,'FINISH');
  INSERT INTO board_climb_stats (board_type, climb_uuid, angle, ascensionist_count, upstream_ascensionist_count,
         boardsesh_ascensionist_count, boardsesh_quality_sum, boardsesh_quality_count,
         quality_average, upstream_quality_average) VALUES
    ('moonboard','s25',25,4,4,0,NULL,NULL,3.5,3.5),
    ('moonboard','s25',40,2,0,2,5,2,2.5,NULL),
    ('moonboard','s40',40,22,20,2,9,2,4.5,NULL);
  INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, origin, status, quality, climbed_at) VALUES
    ('tick-s25-u10','u10','moonboard','s25',40,'native','send',2,'2024-01-10T00:00:00Z'),
    ('tick-s40-u10','u10','moonboard','s40',40,'native','send',5,'2024-06-10T00:00:00Z'),
    ('tick-s25-u11','u11','moonboard','s25',40,'native','send',3,'2024-02-10T00:00:00Z'),
    ('tick-s40-u12','u12','moonboard','s40',40,'native','send',4,'2024-03-10T00:00:00Z'),
    -- Excluded by the ported predicates, one reason each: an attempt is not an
    -- ascent; a non-native (imported) send means u14's ascent is already
    -- inside upstream_ascensionist_count; a detached tick is an upstream log
    -- that was deleted.
    ('tick-s25-u13','u13','moonboard','s25',40,'native','attempt',5,'2024-04-10T00:00:00Z'),
    ('tick-s25-u14','u14','moonboard','s25',40,'moonboard_import','send',5,'2024-04-11T00:00:00Z'),
    ('tick-s40-u15','u15','moonboard','s40',40,'native','send',5,'2024-04-12T00:00:00Z');
  UPDATE boardsesh_ticks SET kilter_detached_at = '2024-05-01T00:00:00Z' WHERE uuid = 'tick-s40-u15';

  -- CASE B: problem Q, two catalog rows BOTH at 25° (identical holds) — a
  -- residual same-angle duplicate this migration must NOT auto-merge.
  INSERT INTO board_climbs (uuid, board_type, layout_id, angle, user_id, is_draft, is_listed, created_at) VALUES
    ('q25a', 'moonboard', 1, 25, NULL, false, true, '2024-01-01T00:00:00Z'),
    ('q25b', 'moonboard', 1, 25, NULL, false, true, '2024-01-02T00:00:00Z');
  INSERT INTO board_climb_holds (board_type, climb_uuid, hold_id, hold_state) VALUES
    ('moonboard','q25a',10,'STARTING'), ('moonboard','q25a',11,'FINISH'),
    ('moonboard','q25b',10,'STARTING'), ('moonboard','q25b',11,'FINISH');
  INSERT INTO board_climb_stats (board_type, climb_uuid, angle, ascensionist_count,
         upstream_ascensionist_count, boardsesh_ascensionist_count) VALUES
    ('moonboard','q25a',25,1,1,0), ('moonboard','q25b',25,1,1,0);

  -- CASE C: problem R, a catalog row at 25° and a user-owned row (user_id set)
  -- that happens to share the identical holds at 30° — must never be grouped
  -- with the catalog row, regardless of matching holds.
  INSERT INTO board_climbs (uuid, board_type, layout_id, angle, user_id, is_draft, is_listed, created_at) VALUES
    ('r25', 'moonboard', 1, 25, NULL, false, true, '2024-01-01T00:00:00Z'),
    ('r30u', 'moonboard', 1, 30, 'owner-1', false, true, '2024-01-01T00:00:00Z');
  INSERT INTO board_climb_holds (board_type, climb_uuid, hold_id, hold_state) VALUES
    ('moonboard','r25',20,'STARTING'), ('moonboard','r25',21,'FINISH'),
    ('moonboard','r30u',20,'STARTING'), ('moonboard','r30u',21,'FINISH');
  INSERT INTO board_climb_stats (board_type, climb_uuid, angle, ascensionist_count,
         upstream_ascensionist_count, boardsesh_ascensionist_count) VALUES
    ('moonboard','r25',25,1,1,0);
`;

/** Build the synthetic schema, seed every case, and apply the migration verbatim. */
export async function prepareMoonboardDedupReplayDatabase(db: postgres.Sql): Promise<void> {
  await db.unsafe(MOONBOARD_DEDUP_REPLAY_SCHEMA_SQL);
  await db.unsafe(MOONBOARD_DEDUP_REPLAY_SEED_SQL);
  await db.unsafe(moonboardDedupReplayMigrationSql());
}

export type MoonboardDedupReplayCheck = {
  name: string;
  run: (db: postgres.Sql) => Promise<void>;
};

/**
 * The replay assertions, framework-agnostic (throw on failure). Both
 * harnesses map each entry to an `it(name, () => run(db))`.
 */
export const moonboardDedupReplayChecks: MoonboardDedupReplayCheck[] = [
  {
    name: 'CASE A: picks p40 (more ascents) as canonical and delists p25',
    run: async (db) => {
      const p25 = await db`SELECT is_listed FROM board_climbs WHERE uuid = 'p25'`;
      assert.equal(p25[0].is_listed, false, 'non-canonical row delisted');
      const p40 = await db`SELECT is_listed FROM board_climbs WHERE uuid = 'p40'`;
      assert.equal(p40[0].is_listed, true, 'canonical row stays listed');
      const p40row = await db`SELECT is_listed FROM board_climbs WHERE uuid = 'p40'`;
      assert.equal(p40row.length, 1, 'canonical row never deleted');
      const p25row = await db`SELECT is_listed FROM board_climbs WHERE uuid = 'p25'`;
      assert.equal(p25row.length, 1, 'alias row never deleted, only delisted');
    },
  },
  {
    name: "CASE A: repoints p25's pre-existing self-alias onto p40 (step 1 ON CONFLICT branch)",
    run: async (db) => {
      const alias = await db`SELECT canonical_uuid, source FROM board_climb_aliases
        WHERE board_type = 'moonboard' AND alias_uuid = 'p25'`;
      assert.equal(alias.length, 1);
      assert.equal(alias[0].canonical_uuid, 'p40', 'repointed to the new canonical');
      assert.equal(
        alias[0].source,
        'moonboard-catalog-import',
        'ON CONFLICT DO UPDATE only touches canonical_uuid/last_seen_at — the pre-existing source is preserved, not overwritten to moonboard-angle-dedup',
      );
    },
  },
  {
    name: 'CASE A: repoints a pre-existing alias chain through p25 straight onto p40 (step 1)',
    run: async (db) => {
      const alias = await db`SELECT canonical_uuid, source FROM board_climb_aliases
        WHERE board_type = 'moonboard' AND alias_uuid = 'p25-prior-alias'`;
      assert.equal(alias.length, 1);
      assert.equal(alias[0].canonical_uuid, 'p40', 'repointed directly to the new canonical, not left on p25');
      assert.equal(
        alias[0].source,
        'moonboard-catalog-import',
        'source untouched — only canonical_uuid/last_seen_at move',
      );
    },
  },
  {
    name: 'CASE A: both angle stats rows survive under the canonical uuid, values preserved',
    run: async (db) => {
      const rows = await db`SELECT angle, upstream_ascensionist_count, quality_average
        FROM board_climb_stats WHERE board_type = 'moonboard' AND climb_uuid = 'p40' ORDER BY angle`;
      assert.equal(rows.length, 2, 'both angles present under one climb_uuid');
      assert.equal(rows[0].angle, 25);
      assert.equal(Number(rows[0].upstream_ascensionist_count), 5);
      assert.equal(rows[0].quality_average, 3.5);
      assert.equal(rows[1].angle, 40);
      assert.equal(Number(rows[1].upstream_ascensionist_count), 20);
      assert.equal(rows[1].quality_average, 4.2);

      const orphaned = await db`SELECT 1 FROM board_climb_stats WHERE board_type = 'moonboard' AND climb_uuid = 'p25'`;
      assert.equal(orphaned.length, 0, 'no stats rows left under the retired uuid');
    },
  },
  {
    name: 'CASE A: ticks repointed, each keeping its own angle',
    run: async (db) => {
      const rows = await db`SELECT angle FROM boardsesh_ticks
        WHERE board_type = 'moonboard' AND climb_uuid = 'p40' ORDER BY angle`;
      assert.deepEqual(
        rows.map((r) => r.angle),
        [25, 40],
      );
    },
  },
  {
    name: 'CASE A: favorites at both angles survive (angle is part of the unique key, no collision)',
    run: async (db) => {
      const rows = await db`SELECT angle FROM user_favorites
        WHERE board_name = 'moonboard' AND climb_uuid = 'p40' AND user_id = 'u1' ORDER BY angle`;
      assert.deepEqual(
        rows.map((r) => r.angle),
        [25, 40],
      );
    },
  },
  {
    name: "CASE A: a favourite collision keeps the canonical's row and the EARLIEST created_at",
    run: async (db) => {
      const rows = await db`SELECT climb_uuid, created_at::text AS created_at_text FROM user_favorites
        WHERE board_name = 'moonboard' AND user_id = 'u9'`;
      assert.equal(rows.length, 1, 'u9 favourited the same problem twice at 40°; one row survives');
      assert.equal(rows[0].climb_uuid, 'p40');
      assert.equal(
        new Date(`${(rows[0].created_at_text as string).replace(' ', 'T')}Z`).toISOString(),
        new Date('2023-02-01T00:00:00Z').toISOString(),
        'earliest-wins: the surviving row carries when u9 FIRST starred the problem, not the later star',
      );
    },
  },
  {
    name: 'CASE A: repointed favourites leave a tombstone for the client key they vacated',
    run: async (db) => {
      // The client keys user_favorites by (board_name, climb_uuid, angle), so
      // a repoint moves the row's primary key on device with no delete trigger
      // to announce it. Without these hand-written rows the old keys would sit
      // on every phone forever.
      const moved = await db`SELECT record_id, user_id FROM sync_deletions
        WHERE table_name = 'user_favorites' AND record_id LIKE 'moonboard:p25:%' ORDER BY record_id`;
      assert.deepEqual(
        moved.map((row) => [row.record_id, row.user_id]),
        [
          ['moonboard:p25:25', 'u1'],
          ['moonboard:p25:40', 'u9'],
        ],
        'one tombstone per vacated key, scoped to the owning user',
      );
    },
  },
  {
    name: 'CASE A: climb_community_status at both angles survives',
    run: async (db) => {
      const rows = await db`SELECT angle, community_grade FROM climb_community_status
        WHERE board_type = 'moonboard' AND climb_uuid = 'p40' ORDER BY angle`;
      assert.deepEqual(
        rows.map((r) => [r.angle, r.community_grade]),
        [
          [25, 'V4'],
          [40, 'V6'],
        ],
      );
    },
  },
  {
    name: 'CASE A: climb_classic_status plain-repoints when the canonical had no row',
    run: async (db) => {
      const rows = await db`SELECT is_classic FROM climb_classic_status
        WHERE board_type = 'moonboard' AND climb_uuid = 'p40'`;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].is_classic, true);
    },
  },
  {
    name: 'CASE A: playlist collision keeps one row, with the EARLIEST added_at and slot',
    run: async (db) => {
      const rows = await db`SELECT climb_uuid, position, added_at::text AS added_at_text
        FROM playlist_climbs WHERE playlist_id = 100`;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].climb_uuid, 'p40');
      assert.equal(rows[0].position, 2, 'keeps the slot the climb was first added at');
      assert.equal(
        new Date(`${(rows[0].added_at_text as string).replace(' ', 'T')}Z`).toISOString(),
        new Date('2023-11-01T00:00:00Z').toISOString(),
        'earliest-wins: p25 went into this playlist first, so its added_at survives',
      );
    },
  },
  {
    name: 'CASE A: the vacated playlist key is tombstoned with the playlist UUID and its owner',
    run: async (db) => {
      const rows = await db`SELECT record_id, user_id FROM sync_deletions
        WHERE table_name = 'playlist_climbs' AND record_id = 'playlist-a-uuid:p25'`;
      assert.equal(rows.length, 1, "log_deletion_playlist_climbs()'s key format: '<playlist uuid>:<climb uuid>'");
      assert.equal(rows[0].user_id, 'u1', 'scoped to the playlist owner, not left global');
    },
  },
  {
    name: 'CASE A: circuit collision keeps the row with the lowest position',
    run: async (db) => {
      const rows = await db`SELECT climb_uuid, position FROM board_circuits_climbs
        WHERE board_type = 'moonboard' AND circuit_uuid = 'circuit-1'`;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].climb_uuid, 'p40');
      assert.equal(rows[0].position, 1, "p25's row sat earlier in the circuit, so its slot is the one kept");
    },
  },
  {
    name: "CASE A: beta link collision keeps the canonical's own row",
    run: async (db) => {
      const rows = await db`SELECT climb_uuid, tick_uuid FROM board_beta_links
        WHERE board_type = 'moonboard' AND link = 'https://example.com/beta'`;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].climb_uuid, 'p40');
      assert.equal(rows[0].tick_uuid, null, "the canonical's own row wins outright, ahead of any signal strength");
    },
  },
  {
    name: 'CASE A: votes deduped to the LATEST vote per user and repointed',
    run: async (db) => {
      const rows = await db`SELECT user_id, value FROM votes
        WHERE entity_type = 'climb' AND entity_id = 'p40' ORDER BY user_id`;
      assert.deepEqual(
        rows.map((r) => [r.user_id, r.value]),
        [
          ['u2', 1],
          ['u3', -1],
          // u4 voted +1 on the canonical in February and -1 on the alias in
          // July. July is what they think of the problem now; keeping the
          // canonical's own row would resurrect an opinion they changed.
          ['u4', -1],
        ],
      );
      const orphaned = await db`SELECT 1 FROM votes WHERE entity_type = 'climb' AND entity_id = 'p25'`;
      assert.equal(orphaned.length, 0);
    },
  },
  {
    name: 'CASE A: vote_counts recomputed matching update_vote_counts() exactly (formula + created_at chain)',
    run: async (db) => {
      const rows = await db`SELECT upvotes, downvotes, score, hot_score, created_at::text AS created_at_text
        FROM vote_counts WHERE entity_type = 'climb' AND entity_id = 'p40'`;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].upvotes, 1);
      assert.equal(rows[0].downvotes, 2);
      assert.equal(rows[0].score, -1);
      // created_at is `timestamp without time zone`; cast to text above (rather
      // than letting postgres.js auto-parse it into a Date) so this assertion
      // doesn't depend on the test runner's local timezone.
      const createdAt = new Date(`${(rows[0].created_at_text as string).replace(' ', 'T')}Z`);
      // feed_items preference wins: p25's earlier feed_item (2024-01-15) got
      // repointed onto p40 by step 3, so it's picked over p40's own later one
      // (2024-06-01) and over MIN(votes.created_at) (2024-02-01).
      assert.equal(
        createdAt.toISOString(),
        new Date('2024-01-15T00:00:00Z').toISOString(),
        'earliest feed_items.created_at kept, matching update_vote_counts()',
      );
      // Plain Unix epoch — NO Reddit-epoch offset. This is update_vote_counts()'s
      // (0053/0130) exact formula, verified against the live trigger this fixture
      // now includes: an earlier version of this migration subtracted
      // TIMESTAMP '2005-12-08', which doesn't appear anywhere in the trigger.
      const expectedHot = Math.sign(-1) * Math.log(Math.max(Math.abs(-1), 1)) + createdAt.getTime() / 1000 / 45000;
      assert.ok(
        Math.abs((rows[0].hot_score as number) - expectedHot) < 1e-6,
        'hot_score matches update_vote_counts() formula exactly',
      );

      const orphaned = await db`SELECT 1 FROM vote_counts WHERE entity_type = 'climb' AND entity_id = 'p25'`;
      assert.equal(orphaned.length, 0, 'alias vote_counts row removed');
    },
  },
  {
    name: 'CASE A: ML caches dropped for the retired uuid on both sides',
    run: async (db) => {
      const embeddings =
        await db`SELECT 1 FROM board_climb_embeddings WHERE board_type = 'moonboard' AND climb_uuid = 'p25'`;
      assert.equal(embeddings.length, 0);
      const similar = await db`SELECT 1 FROM board_climb_similar
        WHERE board_type = 'moonboard' AND (climb_uuid = 'p25' OR neighbor_uuid = 'p25')`;
      assert.equal(similar.length, 0);
    },
  },
  {
    name: 'CASE A: send stats merged (summed) onto the canonical, alias row removed',
    run: async (db) => {
      const rows = await db`SELECT send_count_30d, sender_count_30d, send_count_90d
        FROM board_climb_send_stats WHERE board_type = 'moonboard' AND climb_uuid = 'p40'`;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].send_count_30d, 10);
      assert.equal(rows[0].sender_count_30d, 4);
      assert.equal(rows[0].send_count_90d, 14);
      const orphaned =
        await db`SELECT 1 FROM board_climb_send_stats WHERE board_type = 'moonboard' AND climb_uuid = 'p25'`;
      assert.equal(orphaned.length, 0);
    },
  },
  {
    name: 'CASE A: stats_history, events, proposals, comments, feed_items, notifications all repointed',
    run: async (db) => {
      const history =
        await db`SELECT 1 FROM board_climb_stats_history WHERE board_type = 'moonboard' AND climb_uuid = 'p40'`;
      assert.equal(history.length, 1);
      const historyOrphaned =
        await db`SELECT 1 FROM board_climb_stats_history WHERE board_type = 'moonboard' AND climb_uuid = 'p25'`;
      assert.equal(historyOrphaned.length, 0, 'no stats_history rows left under the retired uuid');
      const events = await db`SELECT 1 FROM board_climb_events WHERE board_type = 'moonboard' AND climb_uuid = 'p40'`;
      assert.equal(events.length, 1);
      const proposals = await db`SELECT 1 FROM climb_proposals WHERE board_type = 'moonboard' AND climb_uuid = 'p40'`;
      assert.equal(proposals.length, 1);
      const comments = await db`SELECT 1 FROM comments WHERE entity_type = 'climb' AND entity_id = 'p40'`;
      assert.equal(comments.length, 1);
      // Two rows: p40's own seeded feed_item plus p25's repointed one (see seed comment).
      const feed = await db`SELECT 1 FROM feed_items WHERE entity_type = 'climb' AND entity_id = 'p40'`;
      assert.equal(feed.length, 2);
      const notif = await db`SELECT 1 FROM notifications WHERE entity_type = 'climb' AND entity_id = 'p40'`;
      assert.equal(notif.length, 1);
    },
  },
  {
    name: 'CASE D: a 3-angle group picks the highest-ascent member as canonical and merges the other two',
    run: async (db) => {
      const climbs = await db`SELECT uuid, is_listed FROM board_climbs WHERE uuid IN ('t25','t40','t55') ORDER BY uuid`;
      assert.deepEqual(
        climbs.map((row) => [row.uuid, row.is_listed]),
        [
          ['t25', false],
          ['t40', true],
          ['t55', false],
        ],
        't40 has the most ascents (50) so it wins canonical; t25/t55 delisted, never deleted',
      );
    },
  },
  {
    name: 'CASE D: all three angle stats rows survive under the canonical uuid',
    run: async (db) => {
      const rows = await db`SELECT angle, upstream_ascensionist_count FROM board_climb_stats
        WHERE board_type = 'moonboard' AND climb_uuid = 't40' ORDER BY angle`;
      assert.deepEqual(
        rows.map((row) => [row.angle, Number(row.upstream_ascensionist_count)]),
        [
          [25, 3],
          [40, 50],
          [55, 7],
        ],
      );
    },
  },
  {
    name: 'CASE D: all three angle ticks repointed, each keeping its own angle',
    run: async (db) => {
      const rows = await db`SELECT angle FROM boardsesh_ticks
        WHERE board_type = 'moonboard' AND climb_uuid = 't40' ORDER BY angle`;
      assert.deepEqual(
        rows.map((row) => row.angle),
        [25, 40, 55],
      );
    },
  },
  {
    name: 'CASE D: no spurious vote_counts row for a climb neither side ever voted on',
    run: async (db) => {
      const rows =
        await db`SELECT 1 FROM vote_counts WHERE entity_type = 'climb' AND entity_id IN ('t25', 't40', 't55')`;
      assert.equal(rows.length, 0, 'recompute, not invent — t25/t40/t55 never had a vote_counts row or any votes');
    },
  },
  {
    name: 'CASE E: migration does not abort on a 3-member group where two non-canonical members collide',
    run: async (db) => {
      // If prepareMoonboardDedupReplayDatabase() threw during setup (the
      // actual failure mode of the bug this reproduces), every test in this
      // file — not just this one — would already have failed. Reaching this
      // assertion at all is itself part of the regression coverage.
      const climbs = await db`SELECT uuid, is_listed FROM board_climbs WHERE uuid IN ('w25','w40','w55') ORDER BY uuid`;
      assert.deepEqual(
        climbs.map((row) => [row.uuid, row.is_listed]),
        [
          ['w25', false],
          ['w40', true],
          ['w55', false],
        ],
        'w40 (most ascents) wins canonical; both losing members delisted, never deleted',
      );
    },
  },
  {
    name: 'CASE E: playlist collision between two non-canonical members keeps the earliest row',
    run: async (db) => {
      const rows = await db`SELECT climb_uuid, position, added_at::text AS added_at_text
        FROM playlist_climbs WHERE playlist_id = 300`;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].climb_uuid, 'w40');
      assert.equal(rows[0].position, 3, "w55's earlier slot survives, not w25's");
      assert.equal(
        new Date(`${(rows[0].added_at_text as string).replace(' ', 'T')}Z`).toISOString(),
        new Date('2023-01-01T00:00:00Z').toISOString(),
        'earliest-wins beats the old lowest-id tiebreak, which would have kept w25 (2024-06-01)',
      );

      // Neither alias was the canonical, so the survivor is an alias row that
      // MOVED: w25's key is tombstoned by the delete trigger, w55's has to be
      // written by hand or every phone keeps a playlist entry pointing at a
      // climb that no longer exists under that uuid.
      const tombstones = await db`SELECT record_id, user_id FROM sync_deletions
        WHERE table_name = 'playlist_climbs' AND record_id LIKE 'playlist-e-uuid:%' ORDER BY record_id`;
      assert.deepEqual(
        tombstones.map((row) => [row.record_id, row.user_id]),
        [
          ['playlist-e-uuid:w25', 'u7'],
          ['playlist-e-uuid:w55', 'u7'],
        ],
      );
    },
  },
  {
    name: 'CASE E: circuit collision between two non-canonical members keeps the lowest position',
    run: async (db) => {
      const rows = await db`SELECT climb_uuid, position FROM board_circuits_climbs
        WHERE board_type = 'moonboard' AND circuit_uuid = 'circuit-2'`;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].climb_uuid, 'w40');
      assert.equal(rows[0].position, 4, "w55 sat earlier in the circuit than w25's position 12");
    },
  },
  {
    name: 'CASE E: classic-status collision (no angle discriminator) keeps the strongest signal',
    run: async (db) => {
      const rows = await db`SELECT climb_uuid, is_classic FROM climb_classic_status
        WHERE board_type = 'moonboard' AND climb_uuid = 'w40'`;
      assert.equal(rows.length, 1);
      assert.equal(
        rows[0].is_classic,
        true,
        "w55's row says classic and w25's says not; the lowest-id tiebreak would have kept the 'not'",
      );
      const orphaned = await db`SELECT 1 FROM climb_classic_status WHERE climb_uuid IN ('w25','w55')`;
      assert.equal(orphaned.length, 0);
    },
  },
  {
    name: 'CASE E: beta-link collision keeps the beta that is tied to a real ascent',
    run: async (db) => {
      const rows = await db`SELECT climb_uuid, tick_uuid FROM board_beta_links
        WHERE board_type = 'moonboard' AND link = 'https://example.com/w-beta'`;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].climb_uuid, 'w40');
      assert.equal(rows[0].tick_uuid, 'tick-w', "w55's tick-linked beta beats w25's loose one");
    },
  },
  {
    name: 'CASE E: community-status collision keeps the most recent community decision',
    run: async (db) => {
      const rows = await db`SELECT climb_uuid, angle, community_grade FROM climb_community_status
        WHERE board_type = 'moonboard' AND climb_uuid = 'w40'`;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].angle, 55);
      assert.equal(rows[0].community_grade, 'V8', "w25's row carried the newer proposal, so its grade survives");
    },
  },
  {
    name: 'CASE E: favourite collision keeps the earliest star and tombstones both vacated keys',
    run: async (db) => {
      const rows = await db`SELECT climb_uuid, angle, created_at::text AS created_at_text
        FROM user_favorites WHERE board_name = 'moonboard' AND user_id = 'u7'`;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].climb_uuid, 'w40');
      assert.equal(rows[0].angle, 25);
      assert.equal(
        new Date(`${(rows[0].created_at_text as string).replace(' ', 'T')}Z`).toISOString(),
        new Date('2022-05-01T00:00:00Z').toISOString(),
      );

      // w25's row was deleted (trigger tombstone), w55's survived but moved
      // (hand-written tombstone). Both keys must be reachable by the client.
      const tombstones = await db`SELECT record_id FROM sync_deletions
        WHERE table_name = 'user_favorites' AND user_id = 'u7' ORDER BY record_id`;
      assert.deepEqual(
        tombstones.map((row) => row.record_id),
        ['moonboard:w25:25', 'moonboard:w55:25'],
      );
    },
  },
  {
    name: 'CASE E: vote collision between two non-canonical members keeps the later vote',
    run: async (db) => {
      const votes = await db`SELECT user_id, value FROM votes WHERE entity_type = 'climb' AND entity_id = 'w40'`;
      assert.equal(votes.length, 1, 'u7 kept exactly one vote after colliding on w25 and w55');
      assert.equal(votes[0].user_id, 'u7');
      assert.equal(votes[0].value, -1, "u7's August downvote on w55 supersedes their February upvote on w25");

      const counts = await db`SELECT upvotes, downvotes, score FROM vote_counts
        WHERE entity_type = 'climb' AND entity_id = 'w40'`;
      assert.equal(counts.length, 1);
      assert.equal(counts[0].upvotes, 0);
      assert.equal(counts[0].downvotes, 1);
      assert.equal(counts[0].score, -1);

      const orphaned = await db`SELECT 1 FROM vote_counts WHERE entity_type = 'climb' AND entity_id IN ('w25','w55')`;
      assert.equal(orphaned.length, 0);
    },
  },
  {
    name: 'CASE F: boardsesh_ascensionist_count is RECOUNTED from ticks, not merged arithmetically',
    run: async (db) => {
      const rows = await db`SELECT ascensionist_count, upstream_ascensionist_count, boardsesh_ascensionist_count
        FROM board_climb_stats WHERE board_type = 'moonboard' AND climb_uuid = 's40' AND angle = 40`;
      assert.equal(rows.length, 1);
      assert.equal(
        Number(rows[0].boardsesh_ascensionist_count),
        3,
        'u10 (both aliases), u11 and u12 are three distinct climbers; ' +
          'summing the stored 2 + 2 gives 4 and taking GREATEST gives 2 — both wrong',
      );
      assert.equal(Number(rows[0].upstream_ascensionist_count), 20);
      assert.equal(Number(rows[0].ascensionist_count), 23, 'materialized total = upstream + boardsesh');
    },
  },
  {
    name: "CASE F: the quality blend uses each climber's LATEST rating and keeps its provenance columns",
    run: async (db) => {
      const rows = await db`SELECT boardsesh_quality_sum, boardsesh_quality_count, quality_average
        FROM board_climb_stats WHERE board_type = 'moonboard' AND climb_uuid = 's40' AND angle = 40`;
      assert.equal(rows.length, 1);
      // u10 rated 2 in January and 5 in June -> 5 counts, 2 does not.
      assert.equal(Number(rows[0].boardsesh_quality_sum), 12, 'u10 -> 5 (latest), u11 -> 3, u12 -> 4');
      assert.equal(Number(rows[0].boardsesh_quality_count), 3, 'one vote per climber, not one per tick');
      assert.ok(
        Math.abs((rows[0].quality_average as number) - 4.0) < 1e-9,
        'no upstream quality on this row, so the blend collapses to the Boardsesh average 12/3',
      );
    },
  },
  {
    name: 'CASE F: ticks that must not count are excluded (attempt, imported send, detached)',
    run: async (db) => {
      // Proven indirectly by the counts above (3, not 6), but asserted here so
      // a regression names the reason rather than just an off-by-N.
      const ticks = await db`SELECT uuid FROM boardsesh_ticks
        WHERE board_type = 'moonboard' AND climb_uuid = 's40' AND angle = 40 ORDER BY uuid`;
      assert.equal(ticks.length, 7, 'every tick was repointed; none were deleted or left behind');
      const orphaned = await db`SELECT 1 FROM boardsesh_ticks WHERE board_type = 'moonboard' AND climb_uuid = 's25'`;
      assert.equal(orphaned.length, 0);
    },
  },
  {
    name: 'CASE F: a re-keyed row with no ticks keeps its upstream quality untouched',
    run: async (db) => {
      const rows = await db`SELECT ascensionist_count, upstream_ascensionist_count, boardsesh_ascensionist_count,
          quality_average, upstream_quality_average
        FROM board_climb_stats WHERE board_type = 'moonboard' AND climb_uuid = 's40' AND angle = 25`;
      assert.equal(rows.length, 1);
      assert.equal(Number(rows[0].upstream_ascensionist_count), 4);
      assert.equal(Number(rows[0].boardsesh_ascensionist_count), 0);
      assert.equal(Number(rows[0].ascensionist_count), 4);
      assert.equal(rows[0].quality_average, 3.5, 'nothing merged into this row, so its upstream average stands');
      assert.equal(rows[0].upstream_quality_average, 3.5);
    },
  },
  {
    name: 'every surviving moonboard stats row satisfies ascensionist_count = upstream + boardsesh',
    run: async (db) => {
      const broken = await db`SELECT climb_uuid, angle, ascensionist_count, upstream_ascensionist_count,
          boardsesh_ascensionist_count
        FROM board_climb_stats
       WHERE board_type = 'moonboard'
         AND COALESCE(ascensionist_count, 0)
             <> COALESCE(upstream_ascensionist_count, 0) + COALESCE(boardsesh_ascensionist_count, 0)`;
      assert.equal(
        broken.length,
        0,
        `the materialized total must stay the sum of its parts; broken rows: ${JSON.stringify(broken)}`,
      );
    },
  },
  {
    name: 'deleted alias stats rows leave a tombstone in the trigger key format',
    run: async (db) => {
      // The migration must not set boardsesh.suppress_sync_tombstones: without
      // these, every device would keep serving stats for a climb that no
      // longer exists under that uuid.
      const rows = await db`SELECT record_id, user_id FROM sync_deletions
        WHERE table_name = 'board_climb_stats' ORDER BY record_id`;
      const keys = rows.map((row) => row.record_id);
      assert.ok(keys.includes('moonboard:p25:25'), `expected a tombstone for p25@25, got ${JSON.stringify(keys)}`);
      assert.ok(keys.includes('moonboard:s25:25'), `expected a tombstone for s25@25, got ${JSON.stringify(keys)}`);
      assert.ok(keys.includes('moonboard:s25:40'), `expected a tombstone for s25@40, got ${JSON.stringify(keys)}`);
      assert.ok(
        rows.every((row) => row.user_id === null),
        'catalog stats are reference data: the tombstone is global, not per-user',
      );
    },
  },
  {
    name: 'delisting a merged-away climb moves its offline sync cursor',
    run: async (db) => {
      // is_listed is a synced column filtered on-device, so the delist only
      // reaches clients if trg_board_climbs_set_sync_fields bumps the cursor.
      const rows = await db`SELECT uuid, sync_seq FROM board_climbs WHERE uuid IN ('p25','p40') ORDER BY uuid`;
      assert.equal(rows.length, 2);
      const [alias, canonical] = rows;
      assert.ok(
        Number(alias.sync_seq) > Number(canonical.sync_seq),
        'the delisted row was re-stamped after the untouched canonical, so it is ahead of every client cursor',
      );
    },
  },
  {
    name: 'CASE B: same-angle collision group left completely untouched',
    run: async (db) => {
      const rows = await db`SELECT uuid, is_listed FROM board_climbs WHERE uuid IN ('q25a','q25b') ORDER BY uuid`;
      assert.equal(rows.length, 2, 'both rows still exist');
      assert.ok(
        rows.every((r) => r.is_listed === true),
        'neither row delisted',
      );
      const aliases = await db`SELECT 1 FROM board_climb_aliases WHERE alias_uuid IN ('q25a','q25b')`;
      assert.equal(aliases.length, 0, 'no alias created for the ambiguous group');
    },
  },
  {
    name: 'CASE C: user-owned climb is never grouped with a matching catalog row',
    run: async (db) => {
      const owned = await db`SELECT is_listed FROM board_climbs WHERE uuid = 'r30u'`;
      assert.equal(owned[0].is_listed, true, 'user-owned row untouched');
      const catalog = await db`SELECT is_listed FROM board_climbs WHERE uuid = 'r25'`;
      assert.equal(catalog[0].is_listed, true, 'lone catalog row untouched (no group of >1 catalog member)');
      const aliases =
        await db`SELECT 1 FROM board_climb_aliases WHERE alias_uuid IN ('r25','r30u') OR canonical_uuid IN ('r25','r30u')`;
      assert.equal(aliases.length, 0);
    },
  },
  {
    name: 'records the guard row; re-application is a no-op',
    run: async (db) => {
      const guardTag = moonboardDedupReplayGuardTag();
      const guards = await db`SELECT tag FROM _bs_migration_guards WHERE tag = ${guardTag}`;
      assert.equal(guards.length, 1);
      await db.unsafe(moonboardDedupReplayMigrationSql());
      const aliasesAfter = await db`SELECT count(*)::int AS n FROM board_climb_aliases WHERE alias_uuid = 'p25'`;
      assert.equal(aliasesAfter[0].n, 1, 're-running is a no-op, not a duplicate alias');
    },
  },
];
