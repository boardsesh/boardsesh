// Fixtures for the two-stream sync suites (issue #6306): a backend that splits a
// board's rows the way the real resolvers do, the two artifacts a snapshot
// download uses, and the privacy revalidation as the engine sees it.
//
// A helper module rather than a third copy of a fetch mock: the suites need the
// SAME answer to "which stream does this row belong to", and that answer is the
// thing under test.

import { vi } from 'vitest';
import type { OfflineDatabase, SqlExecutor } from '../../../database';
import { LATEST_SCHEMA_VERSION, runMigrations } from '../../../db/migrations';
import type { GraphQLFetch } from '../../../mutation-queue/handlers';
import { beginProtectedWithdrawal } from '../../../mutation-queue/drainer';
import { createTestDatabase } from '../../../testing/sqlite-test-db';
import { compareCheckpoints, resetPrivacyScopedProtectedSyncState, type SyncCheckpoint } from '../../checkpoints';
import type { SnapshotSource } from '../../snapshot-bootstrap';
import {
  SNAPSHOT_MANIFEST_FORMAT_VERSION,
  SNAPSHOT_PRIVACY_VERSION,
  type SnapshotGradesArtifact,
  type SnapshotManifest,
  type SnapshotManifestEntry,
} from '../../snapshot-manifest';
import { BOARD_DATA_TABLES, TABLE_CONFIGS } from '../../table-config';

export const EPOCH: SyncCheckpoint = { updatedAt: '1970-01-01T00:00:00.000Z', syncSeq: '0' };

/** A cursor `sequence` days into 2026, so a larger sequence always sorts later. */
export function cursorAt(sequence: number): SyncCheckpoint {
  const day = String(1 + (sequence % 28)).padStart(2, '0');
  const month = String(1 + Math.floor(sequence / 28)).padStart(2, '0');
  return { updatedAt: `2026-${month}-${day}T00:00:00.000Z`, syncSeq: String(sequence) };
}

/**
 * One climb as the server holds it, with the stats and grade row that hang off
 * it. `ownerId: null` is a manufacturer climb; any other owner is a climber's.
 *
 * Which stream carries it has nothing to do with the owner. A climb that is
 * published and listed is public for every viewer: it is in the reference
 * stream and in a snapshot artifact. A draft or an unlisted climb
 * (`fields: { is_draft: true }` / `{ is_listed: false }`) goes to its owner
 * alone, through the protected stream. See `isReferenceClimb`.
 */
export type ServerClimb = {
  uuid: string;
  ownerId: string | null;
  /** The climb row's `(updated_at, sync_seq)`. */
  cursor: SyncCheckpoint;
  boardType?: string;
  layoutId?: number;
  sizeId?: number;
  /** Column overrides for the climb document. */
  fields?: Record<string, unknown>;
  /**
   * Give the climb a stats row. `faUsername` is the stored first-ascent name.
   * `cursor` is the stats row's own `(updated_at, sync_seq)` when it changed
   * apart from its climb (an ascent was logged); the climb's otherwise.
   */
  stats?: { faUsername?: string | null; cursor?: SyncCheckpoint };
  /** Give the climb a grade row, at its own cursor or the climb's. */
  grade?: boolean | { cursor: SyncCheckpoint };
};

/** Published and listed, on a board that has a public catalogue at all. */
export function isReferenceClimb(climb: ServerClimb): boolean {
  return (
    (climb.boardType ?? 'kilter') !== 'spray' && climb.fields?.is_draft !== true && climb.fields?.is_listed !== false
  );
}

export const statsCursorOf = (climb: ServerClimb): SyncCheckpoint => climb.stats?.cursor ?? climb.cursor;
export const gradeCursorOf = (climb: ServerClimb): SyncCheckpoint =>
  typeof climb.grade === 'object' ? climb.grade.cursor : climb.cursor;

/** A `board_climbs` deletion marker, as `syncDeletions` serves it. */
export type ServerDeletion = {
  tableName: string;
  recordId: string;
  deletedAt: string;
  /** Where the marker sits in the deletions stream. */
  cursor: SyncCheckpoint;
};

/**
 * The marker the server writes when a climb leaves the reference set (it became
 * a draft, or unlisted): stamped one second before the row's new `updated_at`,
 * so every device drops its published copy and the owner's re-delivered row,
 * which is newer than the marker, survives the client's `updated_at <=
 * deletedAt` test.
 */
export function leftReferenceMarker(climb: ServerClimb): ServerDeletion {
  const deletedAt = new Date(Date.parse(climb.cursor.updatedAt) - 1000).toISOString();
  return { tableName: 'board_climbs', recordId: climb.uuid, deletedAt, cursor: climb.cursor };
}

export type SyncRequest = {
  queryName: string;
  audience: unknown;
  cursor: SyncCheckpoint | undefined;
  boardType: unknown;
  layoutId: unknown;
};

export type TwoStreamBackendOptions = {
  /** The server's climbs right now. Read on every request, so a test can change them between cycles. */
  climbs: () => ServerClimb[];
  /** The signed-in account. Default `'viewer'`. */
  viewerId?: string;
  /** Whether the viewer may see a climb on a SPRAY WALL. Default: every one. Ignored on a catalogue board. */
  canSee?: (climb: ServerClimb) => boolean;
  /** The deletion markers the server holds right now. Default: none. */
  deletions?: () => ServerDeletion[];
  /** Rows per page. Default 500, the engine's own limit. */
  pageSize?: number;
  /** False models a backend from before the split: it rejects the `audience` argument. */
  supportsAudience?: boolean;
  /** Runs before each answer; may await, throw, or change server state. */
  onRequest?: (request: SyncRequest) => void | Promise<void>;
  /** A spray wall's `syncSprayWalls` document, keyed by layout id. */
  walls?: () => Record<number, Record<string, unknown>>;
  /**
   * Ship the stored first-ascent name on protected stats pages, which the real
   * resolver never does. For proving the device stores none regardless.
   */
  leakProtectedFirstAscent?: boolean;
};

function queryNameOf(query: string): string {
  const match = query.match(/\{\s*\n?\s*(sync[A-Za-z]+)\(/);
  if (!match) throw new Error(`Could not extract query name from: ${query}`);
  return match[1];
}

function climbDocument(climb: ServerClimb): Record<string, unknown> {
  return {
    uuid: climb.uuid,
    board_type: climb.boardType ?? 'kilter',
    layout_id: climb.layoutId ?? 1,
    user_id: climb.ownerId,
    name: climb.uuid,
    compatible_size_ids: [climb.sizeId ?? 12],
    frames: 'p1r13p2r13',
    is_draft: false,
    is_listed: true,
    is_hidden: false,
    retired_by_reset: null,
    updated_at: climb.cursor.updatedAt,
    sync_seq: climb.cursor.syncSeq,
    ...climb.fields,
  };
}

/**
 * A `graphqlFetch` over a small in-memory server that splits each board table
 * by the server's rule:
 *
 *  - `REFERENCE`: every published and listed climb, whoever set it, with its
 *    stats and grades. Nothing on a spray wall. The same answer for everyone.
 *  - `PROTECTED`: the viewer's own climbs that are not in the reference set
 *    (their drafts, their unlisted climbs). On a spray wall, every row the
 *    viewer may see there.
 *  - no `audience`: both, in one stream (what a bundle from before the split
 *    asks for).
 *
 * First-ascent credit: the stored upstream name for a climb with no owner, and
 * none where it would come from Boardsesh ticks, which is every owned climb and
 * every protected page.
 *
 * Pages on the strict `>` keyset and reports `hasMore` as the resolvers do
 * (a full page). An empty page echoes the cursor it was sent.
 */
export function createTwoStreamBackend(options: TwoStreamBackendOptions) {
  const requests: SyncRequest[] = [];
  const canSee = options.canSee ?? (() => true);
  const viewerId = options.viewerId ?? 'viewer';

  const fetch = vi.fn(async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
    const queryName = queryNameOf(query);
    const cursor = variables?.cursor as SyncCheckpoint | undefined;
    const request: SyncRequest = {
      queryName,
      audience: variables?.audience,
      cursor,
      boardType: variables?.boardType,
      layoutId: variables?.layoutId,
    };
    requests.push(request);
    await options.onRequest?.(request);

    if (queryName === 'syncDeletions') {
      const pending = (options.deletions?.() ?? [])
        .filter((deletion) => !cursor || compareCheckpoints(deletion.cursor, cursor) > 0)
        .sort((left, right) => compareCheckpoints(left.cursor, right.cursor));
      const lastDeletion = pending[pending.length - 1];
      return {
        syncDeletions: {
          deletions: pending.map(({ tableName, recordId, deletedAt }) => ({ tableName, recordId, deletedAt })),
          cursor: lastDeletion?.cursor ?? cursor ?? EPOCH,
          hasMore: false,
        },
      } as T;
    }
    if (options.supportsAudience === false && query.includes('$audience')) {
      // graphql-js's validation errors for a document an older schema cannot type.
      throw new Error(
        'Unknown type "SyncAudience".: {"response":{"errors":[{"message":"Unknown type \\"SyncAudience\\"."},{"message":"Unknown argument \\"audience\\" on field \\"Query.' +
          queryName +
          '\\"."}],"status":400}}',
      );
    }

    const emptyPage = { [queryName]: { documents: [], cursor: cursor ?? EPOCH, hasMore: false } } as T;
    const boardType = typeof variables?.boardType === 'string' ? variables.boardType : '';
    const layoutId = Number(variables?.layoutId);
    if (queryName === 'syncSprayWalls') {
      const wall = boardType === 'spray' ? options.walls?.()[layoutId] : undefined;
      if (!wall || cursor) return emptyPage;
      const wallCursor = { updatedAt: String(wall.updated_at), syncSeq: String(wall.sync_seq) };
      return { syncSprayWalls: { documents: [wall], cursor: wallCursor, hasMore: false } } as T;
    }
    const tableName = Object.keys(TABLE_CONFIGS).find((name) => TABLE_CONFIGS[name].queryName === queryName);
    if (!tableName || !BOARD_DATA_TABLES.includes(tableName)) return emptyPage;

    const audience = variables?.audience;
    const isSpray = boardType === 'spray';
    const inStream = (climb: ServerClimb): boolean => {
      // A wall has no public catalogue: everything the viewer may see on it is
      // one stream, which the split calls protected.
      if (isSpray) return audience !== 'REFERENCE' && canSee(climb);
      const isReference = isReferenceClimb(climb);
      const isOwnAndWithheld = climb.ownerId === viewerId && !isReference;
      if (audience === 'REFERENCE') return isReference;
      if (audience === 'PROTECTED') return isOwnAndWithheld;
      return isReference || isOwnAndWithheld;
    };
    const streamClimbs = options
      .climbs()
      .filter((climb) => (climb.boardType ?? 'kilter') === boardType && (climb.layoutId ?? 1) === layoutId)
      .filter(inStream);

    const rows = streamClimbs.flatMap((climb): { document: Record<string, unknown>; cursor: SyncCheckpoint }[] => {
      if (tableName === 'board_climbs') return [{ document: climbDocument(climb), cursor: climb.cursor }];
      const rowKey = { board_type: climb.boardType ?? 'kilter', climb_uuid: climb.uuid, angle: 40 };
      if (tableName === 'board_climb_stats') {
        if (!climb.stats) return [];
        const statsCursor = statsCursorOf(climb);
        const isProtectedPage = audience === 'PROTECTED' || (isSpray && audience === undefined);
        const shipsName = isProtectedPage ? options.leakProtectedFirstAscent === true : climb.ownerId === null;
        return [
          {
            document: {
              ...rowKey,
              display_difficulty: 20,
              ascensionist_count: 3,
              fa_username: shipsName ? (climb.stats.faUsername ?? null) : null,
              fa_at: shipsName && climb.stats.faUsername ? '2020-01-01T00:00:00Z' : null,
              updated_at: statsCursor.updatedAt,
              sync_seq: statsCursor.syncSeq,
            },
            cursor: statsCursor,
          },
        ];
      }
      if (!climb.grade) return [];
      const gradeCursor = gradeCursorOf(climb);
      return [
        {
          document: { ...rowKey, local_grade: 20, computed_at: gradeCursor.updatedAt, sync_seq: gradeCursor.syncSeq },
          cursor: gradeCursor,
        },
      ];
    });

    const pageSize = options.pageSize ?? Number(variables?.limit ?? 500);
    const page = rows
      .filter((row) => !cursor || compareCheckpoints(row.cursor, cursor) > 0)
      .sort((left, right) => compareCheckpoints(left.cursor, right.cursor))
      .slice(0, pageSize);
    const lastRow = page[page.length - 1];
    return {
      [queryName]: {
        documents: page.map((row) => row.document),
        cursor: lastRow?.cursor ?? cursor ?? EPOCH,
        hasMore: page.length === pageSize,
      },
    } as T;
  });

  /** The board-table requests so far, optionally narrowed to one resolver and one stream. */
  const requestsFor = (queryName?: string, audience?: 'REFERENCE' | 'PROTECTED'): SyncRequest[] =>
    requests.filter(
      (request) =>
        request.boardType !== undefined &&
        (queryName === undefined || request.queryName === queryName) &&
        (audience === undefined || request.audience === audience),
    );

  return { fetch: fetch as typeof fetch & GraphQLFetch, requests, requestsFor };
}

/**
 * What mobile's `revalidatePrivateCatalog` does on a privacy event, as far as
 * the engine can see it. The fence goes up first, then ONE transaction
 * withdraws what depends on privacy, which is spray walls and nothing else:
 * the wall rows, every wall climb the viewer does not own with its stats and
 * grades, and the protected cursors of spray scopes.
 *
 * A catalogue board is not touched. Its published climbs are public whoever
 * set them, and its protected stream is the climber's own rows.
 *
 * The mobile suite `privacy-revalidation-sync-meta.test.ts` pins that the real
 * function changes sync_meta in exactly this way, so this cannot drift from it
 * unnoticed.
 */
export async function simulatePrivacyRevalidation(db: OfflineDatabase, viewerId: string): Promise<void> {
  beginProtectedWithdrawal();
  await db.withExclusiveTransactionAsync(async (transaction) => {
    const withdrawn = `board_type = 'spray' AND (user_id IS NULL OR user_id <> ?)`;
    for (const table of ['board_climb_stats', 'board_climb_grades']) {
      await transaction.runAsync(
        `DELETE FROM ${table} WHERE board_type = 'spray'
           AND climb_uuid IN (SELECT uuid FROM board_climbs WHERE ${withdrawn})`,
        [viewerId],
      );
    }
    await transaction.runAsync(`DELETE FROM board_climbs WHERE ${withdrawn}`, [viewerId]);
    await transaction.runAsync('DELETE FROM spray_walls');
    await resetPrivacyScopedProtectedSyncState(transaction);
  });
}

async function deleteOtherClimbersRows(executor: SqlExecutor, viewerId: string): Promise<void> {
  const withdrawn = `((user_id IS NOT NULL AND user_id <> ?) OR (board_type = 'spray' AND user_id IS NULL))`;
  for (const table of ['board_climb_stats', 'board_climb_grades']) {
    await executor.runAsync(
      `DELETE FROM ${table} WHERE climb_uuid IN (SELECT uuid FROM board_climbs WHERE ${withdrawn})`,
      [viewerId],
    );
  }
  await executor.runAsync(`DELETE FROM board_climbs WHERE ${withdrawn}`, [viewerId]);
}

/**
 * What the privacy revalidation of a bundle from BEFORE the two-stream sync did
 * on every event: it deleted every climb another account owns, on every board,
 * with its stats and grades, then every board-table checkpoint and every
 * `scope-complete:` marker. `bootstrap-done:` stayed. It is what a device
 * upgrading from such a bundle arrives with, and what a rollback leaves behind.
 */
export async function simulateOlderBundleRevalidation(db: OfflineDatabase, viewerId: string): Promise<void> {
  await deleteOtherClimbersRows(db, viewerId);
  for (const tableName of BOARD_DATA_TABLES) {
    await db.runAsync('DELETE FROM sync_meta WHERE key LIKE ?', [`checkpoint:${tableName}:%`]);
  }
  await db.runAsync('DELETE FROM sync_meta WHERE key LIKE ?', ['scope-complete:%']);
}

/** `setCheckpoint` as every bundle before the split wrote it: the whole row, replaced. */
export async function olderBundleSetCheckpoint(db: SqlExecutor, key: string, cursor: SyncCheckpoint): Promise<void> {
  await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [key, JSON.stringify(cursor)]);
}

const SNAPSHOT_META_DDL = `CREATE TABLE snapshot_meta (table_name TEXT PRIMARY KEY, watermark_updated_at TEXT,
  watermark_sync_seq TEXT, row_count INTEGER, built_at TEXT, schema_version INTEGER, format_version INTEGER)`;

export const ARTIFACT_BUILT_AT = '2026-12-01T00:00:00.000Z';

function watermarkOf(cursors: SyncCheckpoint[]): SyncCheckpoint {
  return cursors.reduce((latest, cursor) => (compareCheckpoints(cursor, latest) > 0 ? cursor : latest), EPOCH);
}

/**
 * Write the two artifacts a snapshot download uses for one layout, the way the
 * nightly export does: the layout file holds the reference climbs (published
 * and listed, whoever set them) and their stats, the grades file their grade
 * rows. No draft and no unlisted climb is in either. Returns the manifest entry
 * that lists them, marked with the rule the artifact was built under.
 */
export async function buildSnapshotArtifacts(spec: {
  layoutPath: string;
  gradesPath?: string;
  /** The server's climbs when the artifact was built. Drafts and unlisted ones are left out, as the exporter leaves them. */
  climbs: ServerClimb[];
  boardType?: string;
  layoutId?: number;
  formatVersion?: number;
  /**
   * The rule the artifact was built under. Default 2, the current one. `1` is
   * an artifact from before it: built with every owned climb left out, which
   * this fixture then leaves out too.
   */
  privacyVersion?: number;
}): Promise<SnapshotManifestEntry> {
  const boardType = spec.boardType ?? 'kilter';
  const layoutId = spec.layoutId ?? 1;
  const formatVersion = spec.formatVersion ?? SNAPSHOT_MANIFEST_FORMAT_VERSION;
  const privacyVersion = spec.privacyVersion ?? SNAPSHOT_PRIVACY_VERSION;
  const referenceClimbs = spec.climbs
    .filter(isReferenceClimb)
    .filter((climb) => privacyVersion !== 1 || climb.ownerId === null);
  const withStats = referenceClimbs.filter((climb) => climb.stats);
  const withGrade = referenceClimbs.filter((climb) => climb.grade);

  const layout = createTestDatabase(spec.layoutPath);
  try {
    await runMigrations(layout);
    await layout.execAsync(SNAPSHOT_META_DDL);
    for (const climb of referenceClimbs) {
      await layout.runAsync(
        `INSERT INTO board_climbs
           (uuid, board_type, layout_id, user_id, name, frames, is_draft, is_listed, is_hidden, compatible_size_ids, updated_at, sync_seq)
         VALUES (?, ?, ?, ?, ?, 'p1r13p2r13', 0, 1, 0, ?, ?, ?)`,
        [
          climb.uuid,
          boardType,
          layoutId,
          climb.ownerId,
          climb.uuid,
          JSON.stringify([climb.sizeId ?? 12]),
          climb.cursor.updatedAt,
          Number(climb.cursor.syncSeq),
        ],
      );
    }
    for (const climb of withStats) {
      await layout.runAsync(
        `INSERT INTO board_climb_stats
           (board_type, climb_uuid, angle, display_difficulty, ascensionist_count, fa_username, updated_at, sync_seq)
         VALUES (?, ?, 40, 20, 3, ?, ?, ?)`,
        [
          boardType,
          climb.uuid,
          // The stored upstream credit; none where it would come from Boardsesh ticks.
          climb.ownerId === null ? (climb.stats?.faUsername ?? null) : null,
          statsCursorOf(climb).updatedAt,
          Number(statsCursorOf(climb).syncSeq),
        ],
      );
    }
    for (const [tableName, rows, cursorOf] of [
      ['board_climbs', referenceClimbs, (climb: ServerClimb) => climb.cursor],
      ['board_climb_stats', withStats, statsCursorOf],
    ] as const) {
      const watermark = watermarkOf(rows.map(cursorOf));
      await layout.runAsync('INSERT INTO snapshot_meta VALUES (?, ?, ?, ?, ?, ?, ?)', [
        tableName,
        watermark.updatedAt,
        watermark.syncSeq,
        rows.length,
        ARTIFACT_BUILT_AT,
        LATEST_SCHEMA_VERSION,
        formatVersion,
      ]);
    }
  } finally {
    layout.close();
  }

  let grades: SnapshotGradesArtifact | undefined;
  if (spec.gradesPath) {
    const gradesWatermark = watermarkOf(withGrade.map(gradeCursorOf));
    const gradesFile = createTestDatabase(spec.gradesPath);
    try {
      await runMigrations(gradesFile);
      await gradesFile.execAsync(SNAPSHOT_META_DDL);
      for (const climb of withGrade) {
        await gradesFile.runAsync(
          `INSERT INTO board_climb_grades (board_type, climb_uuid, angle, local_grade, computed_at, sync_seq)
           VALUES (?, ?, 40, 20, ?, ?)`,
          [boardType, climb.uuid, gradeCursorOf(climb).updatedAt, Number(gradeCursorOf(climb).syncSeq)],
        );
      }
      await gradesFile.runAsync('INSERT INTO snapshot_meta VALUES (?, ?, ?, ?, ?, ?, ?)', [
        'board_climb_grades',
        gradesWatermark.updatedAt,
        gradesWatermark.syncSeq,
        withGrade.length,
        ARTIFACT_BUILT_AT,
        LATEST_SCHEMA_VERSION,
        formatVersion,
      ]);
    } finally {
      gradesFile.close();
    }
    grades = {
      privacyVersion,
      key: `board-snapshots/v1/${boardType}/${layoutId}/grades.db`,
      url: `https://example.test/${boardType}-${layoutId}-grades.db`,
      bytes: 512,
      contentEncoding: 'identity',
      builtAt: ARTIFACT_BUILT_AT,
      schemaVersion: LATEST_SCHEMA_VERSION,
      tables: {
        board_climb_grades: {
          watermarkUpdatedAt: gradesWatermark.updatedAt,
          watermarkSyncSeq: gradesWatermark.syncSeq,
          rowCount: withGrade.length,
        },
      },
    };
  }

  const tableStats = (rows: ServerClimb[], cursorOf: (climb: ServerClimb) => SyncCheckpoint) => {
    const watermark = watermarkOf(rows.map(cursorOf));
    return { watermarkUpdatedAt: watermark.updatedAt, watermarkSyncSeq: watermark.syncSeq, rowCount: rows.length };
  };
  return {
    privacyVersion,
    boardType,
    layoutId,
    key: `board-snapshots/v1/${boardType}/${layoutId}/layout.db`,
    url: `https://example.test/${boardType}-${layoutId}.db`,
    bytes: 1024,
    contentEncoding: 'identity',
    builtAt: ARTIFACT_BUILT_AT,
    schemaVersion: LATEST_SCHEMA_VERSION,
    tables: {
      board_climbs: tableStats(referenceClimbs, (climb) => climb.cursor),
      board_climb_stats: tableStats(withStats, statsCursorOf),
    },
    ...(grades ? { grades } : {}),
  };
}

export function manifestOf(entries: SnapshotManifestEntry[]): SnapshotManifest {
  return { formatVersion: SNAPSHOT_MANIFEST_FORMAT_VERSION, generatedAt: ARTIFACT_BUILT_AT, entries };
}

/**
 * A snapshot source over files already on disk, counting every transfer. The
 * manifest is whatever `manifest()` returns at the time, so a test can publish
 * one between cycles; `unknown` so it can also serve a format this client
 * rejects.
 */
export function createSnapshotSource(config: {
  manifest: () => unknown;
  layoutPath?: string;
  gradesPath?: string;
  /** Runs while the layout transfer is "on the wire". */
  duringLayoutDownload?: () => void | Promise<void>;
}) {
  const downloadArtifact = vi.fn(async () => {
    await config.duringLayoutDownload?.();
    return config.layoutPath ? { filePath: config.layoutPath } : null;
  });
  const downloadGradesArtifact = vi.fn(async () => (config.gradesPath ? { filePath: config.gradesPath } : null));
  const source: SnapshotSource = {
    fetchManifest: async () => config.manifest(),
    downloadArtifact,
    downloadGradesArtifact,
    // The files are the test's own fixtures and are reused across cycles.
    deleteArtifact: async () => {},
  };
  return { source, downloadArtifact, downloadGradesArtifact };
}
