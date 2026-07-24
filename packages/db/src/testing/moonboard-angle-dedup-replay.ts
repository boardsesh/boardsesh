/**
 * TEST-ONLY fixture for replaying migration 0188_moonboard_angle_dedup_backfill
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
 * The dev-db Docker seed does NOT reproduce the per-angle duplication this
 * migration fixes (it uses an older single-row-per-problem importer), so this
 * synthetic fixture is the only repeatable coverage for the merge logic.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type postgres from 'postgres';

/** packages/db/drizzle, resolved from this file's location. */
export const MOONBOARD_DEDUP_REPLAY_DRIZZLE_DIR = path.resolve(import.meta.dirname, '../../drizzle');

export const MOONBOARD_DEDUP_REPLAY_MIGRATION_TAG = '0188_moonboard_angle_dedup_backfill';

export function moonboardDedupReplayMigrationSql(): string {
  return readFileSync(
    path.join(MOONBOARD_DEDUP_REPLAY_DRIZZLE_DIR, `${MOONBOARD_DEDUP_REPLAY_MIGRATION_TAG}.sql`),
    'utf-8',
  );
}

/**
 * MINIMAL synthetic schema — only the tables migration 0185 touches, with
 * just the columns its SQL references. Deliberately loose on FKs/enums the
 * real schema has (this fixture never runs alongside real app code).
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
    created_at text
  );

  CREATE TABLE board_climb_holds (
    board_type text NOT NULL,
    climb_uuid text NOT NULL REFERENCES board_climbs(uuid) ON UPDATE CASCADE ON DELETE CASCADE,
    hold_id integer NOT NULL,
    frame_number integer NOT NULL DEFAULT 1,
    hold_state text NOT NULL,
    PRIMARY KEY (board_type, climb_uuid, hold_id)
  );

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
    quality_normalized boolean NOT NULL DEFAULT false,
    fa_username text,
    fa_at timestamp,
    upstream_synced_at timestamp,
    PRIMARY KEY (board_type, climb_uuid, angle)
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

  CREATE TABLE boardsesh_ticks (
    id bigserial PRIMARY KEY,
    user_id text NOT NULL,
    board_type text NOT NULL,
    climb_uuid text NOT NULL,
    angle integer NOT NULL,
    status text NOT NULL DEFAULT 'send'
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
    entity_id text NOT NULL
  );

  CREATE TABLE notifications (
    id bigserial PRIMARY KEY,
    entity_type social_entity_type,
    entity_id text
  );

  CREATE TABLE playlist_climbs (
    id bigserial PRIMARY KEY,
    playlist_id bigint NOT NULL,
    climb_uuid text NOT NULL,
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
    UNIQUE (climb_uuid, board_type)
  );

  CREATE TABLE board_beta_links (
    board_type text NOT NULL,
    climb_uuid text NOT NULL,
    link text NOT NULL,
    angle integer,
    PRIMARY KEY (board_type, climb_uuid, link)
  );

  CREATE TABLE user_favorites (
    id bigserial PRIMARY KEY,
    user_id text NOT NULL,
    board_name text NOT NULL,
    climb_uuid text NOT NULL,
    angle integer NOT NULL,
    UNIQUE (user_id, board_name, climb_uuid, angle)
  );

  CREATE TABLE climb_community_status (
    id bigserial PRIMARY KEY,
    climb_uuid text NOT NULL,
    board_type text NOT NULL,
    angle integer NOT NULL,
    community_grade text,
    UNIQUE (climb_uuid, board_type, angle)
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
`;

/**
 * Seed covers four cases:
 *  - CASE A ("p25"/"p40"): the expected shape — one problem graded at two
 *    distinct angles, exercising every repoint/collision/merge path.
 *  - CASE B ("q25a"/"q25b"): a same-angle collision (both members at 25°) —
 *    must be left completely untouched.
 *  - CASE C ("r25"/"r25u"): a catalog row and a user-owned row that happen to
 *    share holds+angle — the user-owned row must never be touched.
 */
export const MOONBOARD_DEDUP_REPLAY_SEED_SQL = `
  -- CASE A: problem P, graded at 25° (fewer ascents) and 40° (more ascents,
  -- so it wins canonical selection).
  INSERT INTO board_climbs (uuid, board_type, layout_id, angle, user_id, is_draft, is_listed, created_at) VALUES
    ('p25', 'moonboard', 1, 25, NULL, false, true, '2024-01-01T00:00:00Z'),
    ('p40', 'moonboard', 1, 40, NULL, false, true, '2023-06-01T00:00:00Z');

  INSERT INTO board_climb_holds (board_type, climb_uuid, hold_id, hold_state) VALUES
    ('moonboard','p25',1,'STARTING'), ('moonboard','p25',2,'FINISH'),
    ('moonboard','p40',1,'STARTING'), ('moonboard','p40',2,'FINISH');

  INSERT INTO board_climb_stats (board_type, climb_uuid, angle, upstream_ascensionist_count, quality_average) VALUES
    ('moonboard','p25',25,5,3.5),
    ('moonboard','p40',40,20,4.2);

  -- A pre-existing alias from an earlier, unrelated merge (e.g. the catalog
  -- importer's own id-based-uuid-vs-legacy-uuid aliasing) already points at
  -- p25, which THIS migration is about to retire. Step 1 must repoint it
  -- straight to the new canonical (p40) rather than leaving a two-hop chain
  -- through a now-delisted row. (p25's own self-alias is intentionally NOT
  -- pre-seeded here — that row is freshly created by this migration, and the
  -- separate 'aliases p25 onto p40' check below asserts its source.)
  INSERT INTO board_climb_aliases (board_type, alias_uuid, canonical_uuid, source) VALUES
    ('moonboard', 'p25-prior-alias', 'p25', 'moonboard-catalog-import');

  INSERT INTO boardsesh_ticks (user_id, board_type, climb_uuid, angle) VALUES
    ('u1','moonboard','p25',25), ('u1','moonboard','p40',40);

  INSERT INTO user_favorites (user_id, board_name, climb_uuid, angle) VALUES
    ('u1','moonboard','p25',25), ('u1','moonboard','p40',40);

  INSERT INTO climb_community_status (climb_uuid, board_type, angle, community_grade) VALUES
    ('p25','moonboard',25,'V4'), ('p40','moonboard',40,'V6');

  -- climb_classic_status: only the alias (p25) has a row — a plain repoint,
  -- no collision, since the canonical (p40) starts with none.
  INSERT INTO climb_classic_status (climb_uuid, board_type, is_classic) VALUES
    ('p25','moonboard',true);

  -- playlist_climbs: BOTH p25 and p40 are in the same playlist -> collision.
  INSERT INTO playlist_climbs (playlist_id, climb_uuid) VALUES (100, 'p25'), (100, 'p40');

  -- board_circuits_climbs: BOTH in the same circuit -> collision.
  INSERT INTO board_circuits_climbs (board_type, circuit_uuid, climb_uuid) VALUES
    ('moonboard','circuit-1','p25'), ('moonboard','circuit-1','p40');

  -- board_beta_links: same link on both -> collision.
  INSERT INTO board_beta_links (board_type, climb_uuid, link, angle) VALUES
    ('moonboard','p25','https://example.com/beta',25),
    ('moonboard','p40','https://example.com/beta',40);

  -- votes: u2 only on p25, u3 only on p40 (no collision); u4 on BOTH (collision).
  INSERT INTO votes (user_id, entity_type, entity_id, value, created_at) VALUES
    ('u2','climb','p25',1,'2024-02-01T00:00:00Z'),
    ('u3','climb','p40',-1,'2024-02-01T00:00:00Z'),
    ('u4','climb','p25',1,'2024-02-01T00:00:00Z'),
    ('u4','climb','p40',1,'2024-02-01T00:00:00Z');
  INSERT INTO vote_counts (entity_type, entity_id, upvotes, downvotes, score, hot_score, created_at) VALUES
    ('climb','p25',2,0,2,1.0,'2024-01-15T00:00:00Z'),
    ('climb','p40',1,0,1,1.0,'2024-06-01T00:00:00Z');

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
  INSERT INTO feed_items (entity_type, entity_id) VALUES ('climb','p25');
  INSERT INTO notifications (entity_type, entity_id) VALUES ('climb','p25');

  -- CASE B: problem Q, two catalog rows BOTH at 25° (identical holds) — a
  -- residual same-angle duplicate this migration must NOT auto-merge.
  INSERT INTO board_climbs (uuid, board_type, layout_id, angle, user_id, is_draft, is_listed, created_at) VALUES
    ('q25a', 'moonboard', 1, 25, NULL, false, true, '2024-01-01T00:00:00Z'),
    ('q25b', 'moonboard', 1, 25, NULL, false, true, '2024-01-02T00:00:00Z');
  INSERT INTO board_climb_holds (board_type, climb_uuid, hold_id, hold_state) VALUES
    ('moonboard','q25a',10,'STARTING'), ('moonboard','q25a',11,'FINISH'),
    ('moonboard','q25b',10,'STARTING'), ('moonboard','q25b',11,'FINISH');
  INSERT INTO board_climb_stats (board_type, climb_uuid, angle, upstream_ascensionist_count) VALUES
    ('moonboard','q25a',25,1), ('moonboard','q25b',25,1);

  -- CASE C: problem R, a catalog row at 25° and a user-owned row (user_id set)
  -- that happens to share the identical holds at 30° — must never be grouped
  -- with the catalog row, regardless of matching holds.
  INSERT INTO board_climbs (uuid, board_type, layout_id, angle, user_id, is_draft, is_listed, created_at) VALUES
    ('r25', 'moonboard', 1, 25, NULL, false, true, '2024-01-01T00:00:00Z'),
    ('r30u', 'moonboard', 1, 30, 'owner-1', false, true, '2024-01-01T00:00:00Z');
  INSERT INTO board_climb_holds (board_type, climb_uuid, hold_id, hold_state) VALUES
    ('moonboard','r25',20,'STARTING'), ('moonboard','r25',21,'FINISH'),
    ('moonboard','r30u',20,'STARTING'), ('moonboard','r30u',21,'FINISH');
  INSERT INTO board_climb_stats (board_type, climb_uuid, angle, upstream_ascensionist_count) VALUES
    ('moonboard','r25',25,1);
`;

/** Build the synthetic schema, seed every case, and apply 0185 verbatim. */
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
    name: 'CASE A: aliases p25 onto p40',
    run: async (db) => {
      const alias = await db`SELECT canonical_uuid, source FROM board_climb_aliases
        WHERE board_type = 'moonboard' AND alias_uuid = 'p25'`;
      assert.equal(alias.length, 1);
      assert.equal(alias[0].canonical_uuid, 'p40');
      assert.equal(alias[0].source, 'moonboard-angle-dedup');
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
        WHERE board_name = 'moonboard' AND climb_uuid = 'p40' ORDER BY angle`;
      assert.deepEqual(
        rows.map((r) => r.angle),
        [25, 40],
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
    name: 'CASE A: playlist collision resolved to exactly one row',
    run: async (db) => {
      const rows = await db`SELECT climb_uuid FROM playlist_climbs WHERE playlist_id = 100`;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].climb_uuid, 'p40');
    },
  },
  {
    name: 'CASE A: circuit collision resolved to exactly one row',
    run: async (db) => {
      const rows = await db`SELECT climb_uuid FROM board_circuits_climbs
        WHERE board_type = 'moonboard' AND circuit_uuid = 'circuit-1'`;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].climb_uuid, 'p40');
    },
  },
  {
    name: 'CASE A: beta link collision resolved to exactly one row',
    run: async (db) => {
      const rows = await db`SELECT climb_uuid FROM board_beta_links
        WHERE board_type = 'moonboard' AND link = 'https://example.com/beta'`;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].climb_uuid, 'p40');
    },
  },
  {
    name: 'CASE A: votes deduped (u4 kept once) and repointed',
    run: async (db) => {
      const rows = await db`SELECT user_id, value FROM votes
        WHERE entity_type = 'climb' AND entity_id = 'p40' ORDER BY user_id`;
      assert.deepEqual(
        rows.map((r) => [r.user_id, r.value]),
        [
          ['u2', 1],
          ['u3', -1],
          ['u4', 1],
        ],
      );
      const orphaned = await db`SELECT 1 FROM votes WHERE entity_type = 'climb' AND entity_id = 'p25'`;
      assert.equal(orphaned.length, 0);
    },
  },
  {
    name: 'CASE A: vote_counts recomputed with the exact hot_score formula and earliest created_at',
    run: async (db) => {
      const rows = await db`SELECT upvotes, downvotes, score, hot_score, created_at::text AS created_at_text
        FROM vote_counts WHERE entity_type = 'climb' AND entity_id = 'p40'`;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].upvotes, 2);
      assert.equal(rows[0].downvotes, 1);
      assert.equal(rows[0].score, 1);
      // created_at is `timestamp without time zone`; cast to text above (rather
      // than letting postgres.js auto-parse it into a Date) so this assertion
      // doesn't depend on the test runner's local timezone.
      const createdAt = new Date(`${(rows[0].created_at_text as string).replace(' ', 'T')}Z`);
      assert.equal(createdAt.toISOString(), new Date('2024-01-15T00:00:00Z').toISOString(), 'MIN(created_at) kept');
      const expectedHot =
        Math.sign(1) * Math.log(Math.max(Math.abs(1), 1)) +
        (createdAt.getTime() - new Date('2005-12-08T00:00:00Z').getTime()) / 1000 / 45000;
      assert.ok(
        Math.abs((rows[0].hot_score as number) - expectedHot) < 1e-6,
        'hot_score matches refresh_vote_counts() formula',
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
      const events = await db`SELECT 1 FROM board_climb_events WHERE board_type = 'moonboard' AND climb_uuid = 'p40'`;
      assert.equal(events.length, 1);
      const proposals = await db`SELECT 1 FROM climb_proposals WHERE board_type = 'moonboard' AND climb_uuid = 'p40'`;
      assert.equal(proposals.length, 1);
      const comments = await db`SELECT 1 FROM comments WHERE entity_type = 'climb' AND entity_id = 'p40'`;
      assert.equal(comments.length, 1);
      const feed = await db`SELECT 1 FROM feed_items WHERE entity_type = 'climb' AND entity_id = 'p40'`;
      assert.equal(feed.length, 1);
      const notif = await db`SELECT 1 FROM notifications WHERE entity_type = 'climb' AND entity_id = 'p40'`;
      assert.equal(notif.length, 1);
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
      const guards = await db`SELECT tag FROM _bs_migration_guards WHERE tag = '0188_moonboard_angle_dedup_backfill'`;
      assert.equal(guards.length, 1);
      await db.unsafe(moonboardDedupReplayMigrationSql());
      const aliasesAfter = await db`SELECT count(*)::int AS n FROM board_climb_aliases WHERE alias_uuid = 'p25'`;
      assert.equal(aliasesAfter[0].n, 1, 're-running is a no-op, not a duplicate alias');
    },
  },
];
