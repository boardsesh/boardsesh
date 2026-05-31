// End-to-end integration tests for the mobile sync layer against the REAL
// on-device SQLite DDL.
//
// Why this file exists (reviewer gap I19): the sibling pull-client.test.ts drives
// `pullSync` with a SQL-recording MOCK database — it asserts on the SQL strings
// `upsertDocuments`/`processDeletions` *emit*, but never runs them through the
// actual SCHEMA_STATEMENTS DDL. So a column-name drift between a backend sync
// resolver (the snake_case keys it emits) and the local DDL column names would
// pass that suite. This file closes that hole by:
//
//   1. Standing up the real DDL via `runMigrations` against node:sqlite (the same
//      adapter migrations.test.ts uses).
//   2. Driving the exported `pullSync` with backend-shaped, snake_case documents
//      whose keys are pinned by docs/sync-table-manifest.md and emitted verbatim
//      by packages/backend/.../sync/queries.ts.
//   3. SELECT-ing the rows back out to prove they landed with the right values.
//
// `INSERT OR REPLACE INTO <table> (<Object.keys(doc)>)` means a resolver key that
// isn't a real DDL column raises `SQLITE_ERROR: table X has no column named Y`,
// which propagates out of `pullSync` and fails the test. That is exactly the
// drift the reviewer worried about. (Proven by the `wrong-key` sanity test below.)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';

import { pullSync } from '../pull-client';
import { enqueue } from '../../mutation-queue/queue';
import { processMutation, type GraphQLFetch } from '../../mutation-queue/handlers';
import { runMigrations } from '../../db/migrations';
import { ensureMutationQueueTable } from '../../mutation-queue/schema';
import { createTestDatabase, type TestSqliteDb } from '../../db/__tests__/sqlite-test-db';

// The non-null fields of the backend's `input SaveTickInput`
// (packages/shared-schema/src/schema/ticks.ts) — i.e. every `Field!` minus the
// optional `uuid` idempotency key. A SaveTick mutation whose `variables.input`
// is missing any of these is rejected by the backend (the Zod
// `SaveTickInputSchema` in packages/backend/src/validation/schemas/ticks.ts
// mirrors them). Kept inline (not imported) so this mobile-package test stays
// hermetic — the backend package is not a mobile dependency. If the SDL changes,
// update this list to match.
const REQUIRED_SAVE_TICK_INPUT_FIELDS = [
  'boardType',
  'climbUuid',
  'angle',
  'isMirror',
  'status',
  'attemptCount',
  'isBenchmark',
  'comment',
  'climbedAt',
] as const;

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const DEFAULT_CURSOR = { updatedAt: '2024-06-01T00:00:00Z', syncSeq: '1' };

type DeletionRecord = { tableName: string; recordId: string; deletedAt: string };

/**
 * Builds a `graphqlFetch` that serves ONE page of `documents` for the named
 * sync query, an empty page for every other sync query, and (by default) an
 * empty `syncDeletions`. Dispatch is by query name, exactly how `pullSync`'s
 * `syncTable` reaches a resolver (`query.includes(config.queryName)`), so this
 * exercises the full pull loop including the hasMore→empty-page termination.
 */
function makeSingleTableFetch(options: {
  queryName: string;
  documents: Record<string, unknown>[];
  cursor?: typeof DEFAULT_CURSOR;
  deletions?: DeletionRecord[];
}): GraphQLFetch {
  const cursor = options.cursor ?? DEFAULT_CURSOR;
  return vi.fn(async <T>(query: string): Promise<T> => {
    if (query.includes('syncDeletions')) {
      return { syncDeletions: { deletions: options.deletions ?? [], cursor, hasMore: false } } as T;
    }
    if (query.includes(options.queryName)) {
      return { [options.queryName]: { documents: options.documents, cursor, hasMore: false } } as T;
    }
    // Every other sync query returns an empty page so the loop is well-formed.
    const otherQueryName = extractQueryName(query);
    return { [otherQueryName]: { documents: [], cursor, hasMore: false } } as T;
  }) as unknown as GraphQLFetch;
}

/** Pulls the resolver field name (e.g. `syncFavorites`) out of a built query string. */
function extractQueryName(query: string): string {
  const match = query.match(/\{\s*\n?\s*(sync[A-Za-z]+)\(/);
  if (!match) throw new Error(`Could not extract query name from: ${query}`);
  return match[1];
}

function createMockQueryClient(): QueryClient {
  return { invalidateQueries: vi.fn().mockResolvedValue(undefined) } as unknown as QueryClient;
}

/** Reads the JSON checkpoint a sync wrote into sync_meta for a table. */
async function readCheckpoint(db: TestSqliteDb, key: string): Promise<typeof DEFAULT_CURSOR | null> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [key]);
  return row ? (JSON.parse(row.value) as typeof DEFAULT_CURSOR) : null;
}

describe('sync layer — real-DDL integration', () => {
  let db: TestSqliteDb;
  let queryClient: QueryClient;

  beforeEach(async () => {
    // A fresh in-memory SQLite with the REAL app DDL (every CREATE TABLE in
    // SCHEMA_STATEMENTS — ticks, favorites, follows, board stats, sync_meta,
    // pending_mutations) applied through the production migration runner.
    db = createTestDatabase();
    await runMigrations(db);
    await ensureMutationQueueTable(db);
    queryClient = createMockQueryClient();
  });

  // -------------------------------------------------------------------------
  // 1. Upsert round-trip per representative table
  // -------------------------------------------------------------------------

  describe('upsert round-trip lands backend-shaped documents in the real tables', () => {
    it('boardsesh_ticks: every manifest column round-trips, booleans map to 0/1, nulls persist', async () => {
      // Snake_case keys + types are exactly what queries.ts:syncTicks selects
      // (uuid, user_id, board_type, climb_uuid, angle, is_mirror, status,
      // attempt_count, quality, difficulty, is_benchmark, comment, climbed_at,
      // session_id, created_at, updated_at). `is_mirror`/`is_benchmark` are JS
      // booleans (the upsert maps them to 0/1); `quality` is null.
      const tickDocument = {
        uuid: 'tick-uuid-1',
        user_id: 'user-42',
        board_type: 'kilter',
        climb_uuid: 'climb-abc',
        angle: 40,
        is_mirror: true,
        status: 'send',
        attempt_count: 3,
        quality: null,
        difficulty: 22,
        is_benchmark: false,
        comment: 'felt soft',
        climbed_at: '2024-05-30T10:00:00Z',
        session_id: 'session-7',
        created_at: '2024-05-30T10:00:00Z',
        updated_at: '2024-05-30T10:05:00Z',
      };
      const cursor = { updatedAt: '2024-05-30T10:05:00Z', syncSeq: '101' };

      await pullSync(
        db,
        queryClient,
        makeSingleTableFetch({ queryName: 'syncTicks', documents: [tickDocument], cursor }),
      );

      const row = await db.getFirstAsync<Record<string, unknown>>('SELECT * FROM boardsesh_ticks WHERE uuid = ?', [
        'tick-uuid-1',
      ]);
      expect(row).not.toBeNull();
      expect(row).toMatchObject({
        uuid: 'tick-uuid-1',
        user_id: 'user-42',
        board_type: 'kilter',
        climb_uuid: 'climb-abc',
        angle: 40,
        is_mirror: 1, // boolean true → INTEGER 1
        status: 'send',
        attempt_count: 3,
        quality: null, // null persisted, not dropped
        difficulty: 22,
        is_benchmark: 0, // boolean false → INTEGER 0
        comment: 'felt soft',
        climbed_at: '2024-05-30T10:00:00Z',
        session_id: 'session-7',
        created_at: '2024-05-30T10:00:00Z',
        updated_at: '2024-05-30T10:05:00Z',
      });

      // Checkpoint advanced to the page's returned cursor.
      expect(await readCheckpoint(db, 'checkpoint:boardsesh_ticks')).toEqual(cursor);
    });

    it('user_favorites: board_name/climb_uuid/angle/user_id/timestamps round-trip; user_id may be null', async () => {
      // queries.ts:syncFavorites selects board_name, climb_uuid, angle, user_id,
      // created_at, updated_at — note board_name (NOT board_type). A null user_id
      // models a row that was written offline before the next sync filled it.
      const favoriteDocument = {
        board_name: 'tension',
        climb_uuid: 'climb-fav-1',
        angle: 25,
        user_id: null,
        created_at: '2024-05-29T08:00:00Z',
        updated_at: '2024-05-29T08:00:00Z',
      };
      const cursor = { updatedAt: '2024-05-29T08:00:00Z', syncSeq: '55' };

      await pullSync(
        db,
        queryClient,
        makeSingleTableFetch({ queryName: 'syncFavorites', documents: [favoriteDocument], cursor }),
      );

      const row = await db.getFirstAsync<Record<string, unknown>>(
        'SELECT * FROM user_favorites WHERE board_name = ? AND climb_uuid = ? AND angle = ?',
        ['tension', 'climb-fav-1', 25],
      );
      expect(row).toMatchObject({
        board_name: 'tension',
        climb_uuid: 'climb-fav-1',
        angle: 25,
        user_id: null,
        created_at: '2024-05-29T08:00:00Z',
        updated_at: '2024-05-29T08:00:00Z',
      });
      expect(await readCheckpoint(db, 'checkpoint:user_favorites')).toEqual(cursor);
    });

    it('user_follows: following_id PK + follower_id + timestamps round-trip', async () => {
      // queries.ts:syncUserFollows selects following_id, follower_id, created_at,
      // updated_at. Local PK is following_id (follower is always the local user).
      const followDocument = {
        following_id: 'followed-user-9',
        follower_id: 'me-1',
        created_at: '2024-05-28T12:00:00Z',
        updated_at: '2024-05-28T12:00:00Z',
      };
      const cursor = { updatedAt: '2024-05-28T12:00:00Z', syncSeq: '77' };

      await pullSync(
        db,
        queryClient,
        makeSingleTableFetch({ queryName: 'syncUserFollows', documents: [followDocument], cursor }),
      );

      const row = await db.getFirstAsync<Record<string, unknown>>('SELECT * FROM user_follows WHERE following_id = ?', [
        'followed-user-9',
      ]);
      expect(row).toMatchObject({
        following_id: 'followed-user-9',
        follower_id: 'me-1',
        created_at: '2024-05-28T12:00:00Z',
        updated_at: '2024-05-28T12:00:00Z',
      });
      expect(await readCheckpoint(db, 'checkpoint:user_follows')).toEqual(cursor);
    });

    it('board_climb_stats: per-board pull lands composite-PK rows with REAL columns and sync_seq', async () => {
      // Per-board table — only runs when a board is enabled. queries.ts:syncClimbStats
      // selects board_type, climb_uuid, angle, display_difficulty, benchmark_difficulty,
      // ascensionist_count, difficulty_average, quality_average, fa_username, fa_at,
      // updated_at, sync_seq. display_difficulty/difficulty_average/quality_average are
      // REAL; fa_username null exercises the null path on a per-board table.
      const statsDocument = {
        board_type: 'kilter',
        climb_uuid: 'climb-stat-1',
        angle: 40,
        display_difficulty: 21.5,
        benchmark_difficulty: 20.0,
        ascensionist_count: 1234,
        difficulty_average: 21.3,
        quality_average: 4.6,
        fa_username: null,
        fa_at: '2023-01-01T00:00:00Z',
        updated_at: '2024-05-27T00:00:00Z',
        sync_seq: 9001,
      };
      const cursor = { updatedAt: '2024-05-27T00:00:00Z', syncSeq: '9001' };

      await pullSync(
        db,
        queryClient,
        makeSingleTableFetch({ queryName: 'syncClimbStats', documents: [statsDocument], cursor }),
        { enabledBoards: ['kilter'] },
      );

      const row = await db.getFirstAsync<Record<string, unknown>>(
        'SELECT * FROM board_climb_stats WHERE board_type = ? AND climb_uuid = ? AND angle = ?',
        ['kilter', 'climb-stat-1', 40],
      );
      expect(row).toMatchObject({
        board_type: 'kilter',
        climb_uuid: 'climb-stat-1',
        angle: 40,
        display_difficulty: 21.5,
        benchmark_difficulty: 20.0,
        ascensionist_count: 1234,
        difficulty_average: 21.3,
        quality_average: 4.6,
        fa_username: null,
        fa_at: '2023-01-01T00:00:00Z',
        updated_at: '2024-05-27T00:00:00Z',
        sync_seq: 9001,
      });
      // Per-board checkpoint is namespaced by board type.
      expect(await readCheckpoint(db, 'checkpoint:board_climb_stats:kilter')).toEqual(cursor);
    });

    it('SANITY: a document with a column the DDL does not have makes pullSync throw (catches resolver↔DDL drift)', async () => {
      // This is the very failure the reviewer's I19 gap is about: if a backend
      // resolver emitted, say, `board_type` for favorites (the DDL column is
      // `board_name`), INSERT OR REPLACE references a non-existent column and
      // SQLite raises an error that propagates out of pullSync. The SQL-recording
      // mock in pull-client.test.ts would NOT catch this. Here it must.
      const driftedFavorite = {
        board_type: 'tension', // WRONG: DDL column is board_name
        climb_uuid: 'climb-drift',
        angle: 25,
      };

      await expect(
        pullSync(db, queryClient, makeSingleTableFetch({ queryName: 'syncFavorites', documents: [driftedFavorite] })),
      ).rejects.toThrow(/no column named board_type/i);

      // And the correctly-keyed document (board_name) does NOT throw — proving the
      // failure above is specifically the wrong column, not a harness artifact.
      await expect(
        pullSync(
          db,
          queryClient,
          makeSingleTableFetch({
            queryName: 'syncFavorites',
            documents: [{ board_name: 'tension', climb_uuid: 'climb-drift', angle: 25 }],
          }),
        ),
      ).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // 2. INSERT OR REPLACE idempotency (the PK actually dedupes)
  // -------------------------------------------------------------------------

  describe('INSERT OR REPLACE idempotency proves the DDL primary key dedupes', () => {
    it('boardsesh_ticks: re-upserting the same uuid replaces the row, keeping the latest non-key fields', async () => {
      const firstVersion = {
        uuid: 'tick-dup',
        user_id: 'user-1',
        board_type: 'kilter',
        climb_uuid: 'climb-1',
        angle: 40,
        status: 'attempt',
        attempt_count: 1,
        comment: 'first',
        updated_at: '2024-05-01T00:00:00Z',
      };
      await pullSync(db, queryClient, makeSingleTableFetch({ queryName: 'syncTicks', documents: [firstVersion] }));

      const secondVersion = {
        ...firstVersion,
        status: 'send',
        attempt_count: 5,
        comment: 'second',
        updated_at: '2024-05-02T00:00:00Z',
      };
      await pullSync(db, queryClient, makeSingleTableFetch({ queryName: 'syncTicks', documents: [secondVersion] }));

      const rows = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM boardsesh_ticks WHERE uuid = ?', [
        'tick-dup',
      ]);
      expect(rows).toHaveLength(1); // PK deduped — NOT two rows
      expect(rows[0]).toMatchObject({
        status: 'send',
        attempt_count: 5,
        comment: 'second',
        updated_at: '2024-05-02T00:00:00Z',
      });
    });

    it('board_climb_stats: re-upserting the same (board_type, climb_uuid, angle) replaces; a different angle inserts', async () => {
      const base = {
        board_type: 'kilter',
        climb_uuid: 'climb-x',
        angle: 40,
        display_difficulty: 20.0,
        ascensionist_count: 10,
        updated_at: '2024-05-01T00:00:00Z',
        sync_seq: 1,
      };
      await pullSync(
        db,
        queryClient,
        makeSingleTableFetch({
          queryName: 'syncClimbStats',
          documents: [base],
          cursor: { updatedAt: '2024-05-01T00:00:00Z', syncSeq: '1' },
        }),
        { enabledBoards: ['kilter'] },
      );

      // Same composite key, changed stat → must REPLACE, not duplicate.
      const updated = {
        ...base,
        display_difficulty: 24.0,
        ascensionist_count: 99,
        updated_at: '2024-05-03T00:00:00Z',
        sync_seq: 2,
      };
      // Different angle but same climb → must be a SEPARATE row (angle is part of PK).
      const differentAngle = { ...base, angle: 50, display_difficulty: 30.0, sync_seq: 3 };
      await pullSync(
        db,
        queryClient,
        makeSingleTableFetch({
          queryName: 'syncClimbStats',
          documents: [updated, differentAngle],
          cursor: { updatedAt: '2024-05-03T00:00:00Z', syncSeq: '3' },
        }),
        { enabledBoards: ['kilter'] },
      );

      const angle40 = await db.getAllAsync<Record<string, unknown>>(
        'SELECT * FROM board_climb_stats WHERE board_type = ? AND climb_uuid = ? AND angle = ?',
        ['kilter', 'climb-x', 40],
      );
      expect(angle40).toHaveLength(1);
      expect(angle40[0]).toMatchObject({ display_difficulty: 24.0, ascensionist_count: 99 });

      const totalForClimb = await db.getAllAsync<Record<string, unknown>>(
        'SELECT angle FROM board_climb_stats WHERE board_type = ? AND climb_uuid = ? ORDER BY angle',
        ['kilter', 'climb-x'],
      );
      // angle 40 (replaced) + angle 50 (new) = two distinct rows.
      expect(totalForClimb.map((statsRow) => statsRow.angle)).toEqual([40, 50]);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Deletion round-trip (record_id encoding ↔ primaryKeyColumns length)
  // -------------------------------------------------------------------------

  describe('deletion round-trip removes the right local rows and proves PK segment counts', () => {
    async function seedTick(uuid: string): Promise<void> {
      await db.runAsync(
        "INSERT INTO boardsesh_ticks (uuid, board_type, climb_uuid, angle, status) VALUES (?, 'kilter', 'c', 40, 'send')",
        [uuid],
      );
    }

    it('deletes a 1-segment tick (record_id = uuid), a 3-segment favorite, and a 3-segment stat row', async () => {
      // Seed the three target rows directly (deletion is independent of how a row
      // arrived). board_climb_stats local PK is (board_type, climb_uuid, angle).
      await seedTick('tick-del-1');
      await seedTick('tick-keep'); // a row the deletion must NOT touch
      await db.runAsync(
        "INSERT INTO user_favorites (board_name, climb_uuid, angle, user_id) VALUES ('kilter', 'fav-climb', 40, 'u1')",
      );
      await db.runAsync(
        "INSERT INTO board_climb_stats (board_type, climb_uuid, angle, sync_seq) VALUES ('kilter', 'stat-climb', 40, 1)",
      );

      const deletions: DeletionRecord[] = [
        // ticks: record_id = OLD.uuid (1 segment)
        { tableName: 'boardsesh_ticks', recordId: 'tick-del-1', deletedAt: '2024-06-01T00:00:00Z' },
        // user_favorites: record_id = board_name:climb_uuid:angle (3 segments)
        { tableName: 'user_favorites', recordId: 'kilter:fav-climb:40', deletedAt: '2024-06-01T00:00:01Z' },
        // board_climb_stats: record_id = board_type:climb_uuid:angle (3 segments)
        { tableName: 'board_climb_stats', recordId: 'kilter:stat-climb:40', deletedAt: '2024-06-01T00:00:02Z' },
      ];

      // syncDeletions runs at the end of pullSync, after all table pulls. Serve the
      // tombstones there; every sync query returns an empty page.
      await pullSync(db, queryClient, makeSingleTableFetch({ queryName: 'syncTicks', documents: [], deletions }));

      // Each targeted row is gone.
      expect(await db.getFirstAsync('SELECT uuid FROM boardsesh_ticks WHERE uuid = ?', ['tick-del-1'])).toBeNull();
      expect(
        await db.getFirstAsync(
          'SELECT climb_uuid FROM user_favorites WHERE board_name = ? AND climb_uuid = ? AND angle = ?',
          ['kilter', 'fav-climb', 40],
        ),
      ).toBeNull();
      expect(
        await db.getFirstAsync(
          'SELECT climb_uuid FROM board_climb_stats WHERE board_type = ? AND climb_uuid = ? AND angle = ?',
          ['kilter', 'stat-climb', 40],
        ),
      ).toBeNull();

      // The untargeted tick survives — deletions are scoped to their record_id.
      expect(await db.getFirstAsync('SELECT uuid FROM boardsesh_ticks WHERE uuid = ?', ['tick-keep'])).not.toBeNull();
    });

    it('skips a mismatched-segment record_id rather than mis-deleting (composite PK guard, class B9)', async () => {
      // board_climb_stats PK has 3 columns. A 2-segment record_id (one segment
      // short) must be skipped — NOT split across the wrong columns, which could
      // delete an unintended row. This pins primaryKeyColumns.length == the
      // trigger's segment count for the composite tables.
      await db.runAsync(
        "INSERT INTO board_climb_stats (board_type, climb_uuid, angle, sync_seq) VALUES ('kilter', 'survivor', 40, 1)",
      );
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const deletions: DeletionRecord[] = [
        { tableName: 'board_climb_stats', recordId: 'survivor:40', deletedAt: '2024-06-01T00:00:00Z' }, // 2 segs, need 3
      ];

      await pullSync(db, queryClient, makeSingleTableFetch({ queryName: 'syncTicks', documents: [], deletions }));

      // Row is untouched and a warning was logged.
      expect(
        await db.getFirstAsync(
          'SELECT climb_uuid FROM board_climb_stats WHERE board_type = ? AND climb_uuid = ? AND angle = ?',
          ['kilter', 'survivor', 40],
        ),
      ).not.toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Skipping deletion: expected 3 PK parts for board_climb_stats, got 2'),
      );
      warnSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // 4. Offline tick payload vs. the backend SaveTickInput contract
  // -------------------------------------------------------------------------

  describe('offline tick mutation dispatch — SaveTickInput conformance', () => {
    it('dispatches saveTick with variables.input carrying the uuid idempotency key', async () => {
      // What the dual-write tick path (hooks.ts:useSaveTick → writeTickLocal)
      // enqueues: the FULL SaveTickInput payload, keyed by the freshly-generated
      // tick uuid. buildDispatch then folds that uuid into variables.input.uuid
      // (the ON CONFLICT (uuid) DO NOTHING idempotency key) and spreads the payload.
      const offlinePayload = {
        boardType: 'kilter',
        climbUuid: 'climb-offline-1',
        angle: 40,
        status: 'send',
        attemptCount: 2,
        quality: 4,
        difficulty: 21,
        comment: 'sent it',
        isMirror: false,
        isBenchmark: false,
        climbedAt: '2024-05-30T10:00:00.000Z',
      };
      const tickUuid = 'offline-tick-uuid-1';

      // Real enqueue into the real pending_mutations table.
      await enqueue(db, 'boardsesh_ticks', 'create', offlinePayload, tickUuid);
      const queued = await db.getFirstAsync<{
        id: number;
        table_name: string;
        operation: string;
        payload: string;
        idempotency_key: string;
        created_at: string;
        retry_count: number;
        max_retries: number;
        last_error: string | null;
        status: string;
      }>('SELECT * FROM pending_mutations WHERE idempotency_key = ?', [tickUuid]);
      expect(queued).not.toBeNull();

      // Capture the variables buildDispatch produces for the SaveTick mutation.
      let capturedVariables: Record<string, unknown> | undefined;
      const captureFetch = vi.fn(async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
        if (query.includes('saveTick')) capturedVariables = variables;
        return {} as T;
      }) as unknown as GraphQLFetch;

      await processMutation(queued!, captureFetch);

      const input = capturedVariables?.input as Record<string, unknown> | undefined;
      expect(input).toBeDefined();
      // The idempotency key is carried as input.uuid (offline replay safety).
      expect(input?.uuid).toBe(tickUuid);
      // The payload fields are spread through verbatim.
      expect(input).toMatchObject(offlinePayload);
    });

    it('dispatches every required SaveTickInput field, including climbedAt (gap closed)', async () => {
      // The backend `input SaveTickInput` (packages/shared-schema/src/schema/ticks.ts)
      // requires a non-null `climbedAt: String!` (and the Zod SaveTickInputSchema
      // mirrors it). The dual-write tick path now enqueues the FULL SaveTickInput
      // the UI builds — which carries climbedAt (QuickTickBar / LogAscentSheet set
      // it to new Date().toISOString()) — so the variables.input that buildDispatch
      // produces and POSTs to the backend is complete and accepted. This pins the
      // previously-documented gap as CLOSED: missingRequired is now empty.
      const offlinePayload = {
        boardType: 'kilter',
        climbUuid: 'climb-offline-2',
        angle: 40,
        status: 'send',
        attemptCount: 2,
        quality: 4,
        difficulty: 21,
        comment: 'sent it',
        isMirror: false,
        isBenchmark: false,
        climbedAt: '2024-05-30T10:00:00.000Z',
      };
      const tickUuid = 'offline-tick-uuid-2';

      await enqueue(db, 'boardsesh_ticks', 'create', offlinePayload, tickUuid);
      const queued = await db.getFirstAsync<{
        id: number;
        table_name: string;
        operation: string;
        payload: string;
        idempotency_key: string;
        created_at: string;
        retry_count: number;
        max_retries: number;
        last_error: string | null;
        status: string;
      }>('SELECT * FROM pending_mutations WHERE idempotency_key = ?', [tickUuid]);

      let capturedInput: Record<string, unknown> | undefined;
      const captureFetch = vi.fn(async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
        if (query.includes('saveTick')) capturedInput = variables?.input as Record<string, unknown>;
        return {} as T;
      }) as unknown as GraphQLFetch;

      await processMutation(queued!, captureFetch);

      // Every required SaveTickInput field is present — the dual-write path
      // enqueues the complete input, so nothing the backend requires is dropped.
      const presentRequired = REQUIRED_SAVE_TICK_INPUT_FIELDS.filter((field) => capturedInput?.[field] !== undefined);
      const missingRequired = REQUIRED_SAVE_TICK_INPUT_FIELDS.filter((field) => capturedInput?.[field] === undefined);

      // The gap is closed: nothing missing, and climbedAt specifically is carried.
      expect(missingRequired).toEqual([]);
      expect(presentRequired).toEqual([...REQUIRED_SAVE_TICK_INPUT_FIELDS]);
      expect(capturedInput?.climbedAt).toBe('2024-05-30T10:00:00.000Z');
    });
  });
});
