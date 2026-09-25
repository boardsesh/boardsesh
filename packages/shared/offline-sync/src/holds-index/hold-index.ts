// The device-derived holds index: `board_climb_holds` rows built on the phone from
// the `frames` string every downloaded climb already carries.
//
// Two local readers need per-hold rows with an index — similar climbs (which
// climbs share these holds?) and the hold heatmap (how often is each hold used?)
// — and neither can afford to ask Postgres for them. The frames are already on
// disk, so the rows are derived here instead of downloaded.
//
// The shape of the build, and why:
//
//  - FIRST BUILD IN UUID ORDER. The primary key leads with (board_type,
//    climb_uuid). Walking a fresh scope in `sync_seq` order inserts random uuids,
//    so once the table is large every chunk rewrites ~1,000 scattered pages. The
//    first build walks `uuid` order instead, so inserts append, then hands over
//    to the incremental phase at the scope's `MAX(sync_seq)` from when it began.
//    Both phases resume from sync_meta after a kill.
//
//  - WATERMARK PER SCOPE, on `sync_seq` only. One `holds-index:<scopeKey>` row in
//    sync_meta per downloaded (boardType, layoutId, sizeId). Per SCOPE rather than
//    per layout because a second size of the same layout imports its own climbs
//    with older `sync_seq` values, which a per-layout watermark would skip
//    forever. `sync_seq` is the server's per-row change counter (a sequence bumped
//    on every UPDATE); the client upsert and the snapshot import both preserve it,
//    so "newer than the watermark" is exactly "new or edited since the last build".
//    `updatedAt` is stored beside it for humans reading sync_meta, never compared.
//
//  - ONLY COMPLETE SCOPES. A scope mid-crawl receives rows in cursor order, not
//    `sync_seq` order, so a watermark taken from a partial catalog could sit above
//    rows the crawl has not delivered yet, and they would never be indexed. The
//    build waits for `scope-complete:` and re-checks it under the write lock, which
//    also makes it safe against a teardown landing between chunks: the teardown
//    deletes that marker in the same transaction as the rows.
//
//  - SHORT LOCKS. Climbs are read 500 at a time on the main connection with no
//    transaction open (a WAL reader never blocks the writer), parsed in JS, then
//    written in ONE short IMMEDIATE transaction per chunk: delete the chunk's old
//    rows, insert the new ones, advance the watermark. Rows and watermark commit
//    together, so a killed app resumes at the last committed chunk (#4314).
//
//  - ONLY LISTED, PUBLISHED, NOT HIDDEN climbs get rows. Neither reader looks at
//    anything else. The watermark still advances past the others, and a climb that
//    flips hidden later gets a new `sync_seq`, is re-read, and loses its rows.
//
//  - ORPHANS ARE DELETED TARGETED, never by a `NOT EXISTS` sweep under the write
//    lock: the tombstone cascade and scope teardown delete a climb's rows with the
//    climb, and `sweepOrphans` (after a snapshot import, whose reconcile step
//    deletes local climbs) discovers orphans with a lock-free read first.
//
// The frames parser is INJECTED (`HoldRowParser`): this package has zero runtime
// dependencies by contract, and the parser lives in @boardsesh/board-constants.

import type { OfflineDatabase, QueryInvalidator, SqlExecutor, SqlValue } from '../database';
import { offlineBoardKey, type OfflineBoardScope } from '../offline-board-key';
import { climbsScopeFilter } from '../sync/board-scope-sql';
import { isScopeDownloadComplete } from '../sync/checkpoints';
import { invalidateKeysForTable } from '../sync/invalidate-keys';
import { buildMultiRowInsertSql, multiRowChunkSize, runPullWrite, SQLITE_MAX_BIND_VARIABLES } from '../sync/pull-write';

/** One derived row: a hold a climb lights, and the role it lights it in. */
export type HoldRow = { holdId: number; holdState: string };

/**
 * Turns a climb's `frames` string into its hold rows. Must match what Postgres
 * persists for the same climb: first occurrence per hold wins across frames, and
 * unknown role codes are dropped. Mobile binds `parseFramesToHoldRows` from
 * @boardsesh/board-constants.
 */
export type HoldRowParser = (boardType: string, frames: string) => readonly HoldRow[];

export type EnsureHoldIndexOptions = {
  parseHoldRows: HoldRowParser;
  /**
   * Checked before every chunk's read and again under its write lock. Returning
   * false stops the build with nothing half-written: the chunk in hand is
   * dropped and the watermark stays at the last committed chunk.
   */
  shouldContinue?: () => boolean;
  /**
   * Delete rows whose climb is gone. Only needed after a snapshot import, whose
   * reconcile step deletes local climbs without a tombstone.
   */
  sweepOrphans?: boolean;
  /** When given, the `board_climb_holds` query keys are invalidated after rows changed. */
  queryClient?: QueryInvalidator;
  /** Climbs per chunk. Defaults to HOLD_INDEX_CHUNK_CLIMBS; a test seam. */
  chunkClimbs?: number;
};

export type EnsureHoldIndexResult = {
  /**
   * `complete` — the index covers every climb of the scope.
   * `aborted` — `shouldContinue` said stop; committed chunks are kept.
   * `not-downloaded` — the scope has no `scope-complete:` marker, so nothing ran.
   */
  status: 'complete' | 'aborted' | 'not-downloaded';
  /** Climbs read from `board_climbs` and committed past the watermark. */
  climbsProcessed: number;
  /** Hold rows inserted. */
  rowsInserted: number;
  /** Hold rows deleted, re-derivations and swept orphans included. */
  rowsDeleted: number;
  /** Write transactions committed. */
  chunks: number;
};

/** Climbs read and written per chunk. 500 uuids stay well under the bind ceiling. */
export const HOLD_INDEX_CHUNK_CLIMBS = 500;

/** Prefix of the per-scope watermark key in sync_meta. */
export const HOLD_INDEX_KEY_PREFIX = 'holds-index:';

/** The sync_meta key holding one scope's holds-index watermark. */
export function holdIndexKey(scopeKey: string): string {
  return `${HOLD_INDEX_KEY_PREFIX}${scopeKey}`;
}

/**
 * The per-scope build state in sync_meta.
 *
 * `initial` — the first build of a scope, walking climbs in `uuid` order from
 * `lastUuid`. `targetSyncSeq` is the scope's highest `sync_seq` when the walk
 * began; the walk ends by stamping `incremental` at that value, so a climb that
 * arrives or changes mid-walk (always above it) is picked up afterwards.
 *
 * `incremental` — every climb up to `syncSeq` is indexed; later work walks
 * `sync_seq` order from there.
 */
type HoldIndexWatermark =
  | { phase: 'initial'; lastUuid: string | null; targetSyncSeq: number }
  | { phase: 'incremental'; syncSeq: number; updatedAt: string | null };

const HOLD_COLUMNS = ['board_type', 'climb_uuid', 'hold_id', 'hold_state'] as const;

class HoldIndexChunkAbortedError extends Error {}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseWatermark(raw: string | null | undefined): HoldIndexWatermark | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (record.phase === 'initial' && isFiniteNumber(record.targetSyncSeq)) {
      return {
        phase: 'initial',
        lastUuid: typeof record.lastUuid === 'string' ? record.lastUuid : null,
        targetSyncSeq: record.targetSyncSeq,
      };
    }
    if (isFiniteNumber(record.syncSeq)) {
      return {
        phase: 'incremental',
        syncSeq: record.syncSeq,
        updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null,
      };
    }
    return null;
  } catch {
    // A row we cannot read is a row we rebuild from: the build is idempotent.
    return null;
  }
}

async function readRawWatermark(db: SqlExecutor, scopeKey: string): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [
    holdIndexKey(scopeKey),
  ]);
  return row?.value ?? null;
}

/**
 * Is there any climb in this scope the index has not covered yet? No index, or
 * an unfinished first build, is behind by definition; otherwise one indexed
 * probe on `idx_climbs_sync_seq`, cheap enough to run before every local read.
 * Says nothing about whether the scope is downloaded; `ensureHoldIndex` checks that.
 */
export async function isHoldIndexBehind(db: SqlExecutor, scope: OfflineBoardScope): Promise<boolean> {
  const watermark = parseWatermark(await readRawWatermark(db, offlineBoardKey(scope)));
  if (!watermark || watermark.phase === 'initial') return true;
  const filter = climbsScopeFilter(scope);
  const row = await db.getFirstAsync<{ behind: number }>(
    `SELECT 1 AS behind FROM board_climbs WHERE ${filter.sql} AND sync_seq > ? LIMIT 1`,
    [...filter.params, watermark.syncSeq],
  );
  return row !== null;
}

type ClimbChunkRow = {
  uuid: string;
  frames: string | null;
  updated_at: string | null;
  sync_seq: number;
  is_listed: number | null;
  is_draft: number | null;
  is_hidden: number | null;
};

const CLIMB_CHUNK_COLUMNS = 'uuid, frames, updated_at, sync_seq, is_listed, is_draft, is_hidden';

/** Listed, published and not hidden: the only climbs either reader can show. */
function isIndexable(climb: ClimbChunkRow): boolean {
  return climb.is_listed === 1 && climb.is_draft === 0 && (climb.is_hidden ?? 0) === 0;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/**
 * Delete the hold rows of climbs that no longer exist. Discovery is a plain read
 * with no transaction, so the lock is held only for the targeted delete, which
 * re-checks each climb's absence in case a pull re-added it in between.
 */
async function sweepOrphanRows(db: OfflineDatabase, boardType: string): Promise<number> {
  const orphans = await db.getAllAsync<{ climb_uuid: string }>(
    `SELECT DISTINCT holds.climb_uuid FROM board_climb_holds holds
     WHERE holds.board_type = ?
       AND NOT EXISTS (SELECT 1 FROM board_climbs climbs WHERE climbs.uuid = holds.climb_uuid)`,
    [boardType],
  );
  if (orphans.length === 0) return 0;

  let deleted = 0;
  const perStatement = SQLITE_MAX_BIND_VARIABLES - 1;
  await runPullWrite(db, async (transaction) => {
    deleted = 0;
    for (let start = 0; start < orphans.length; start += perStatement) {
      const batch = orphans.slice(start, start + perStatement).map((orphan) => orphan.climb_uuid);
      const result = await transaction.runAsync(
        `DELETE FROM board_climb_holds
         WHERE board_type = ? AND climb_uuid IN (${placeholders(batch.length)})
           AND NOT EXISTS (SELECT 1 FROM board_climbs climbs WHERE climbs.uuid = board_climb_holds.climb_uuid)`,
        [boardType, ...batch],
      );
      deleted += result.changes;
    }
  });
  return deleted;
}

async function buildHoldIndex(
  db: OfflineDatabase,
  scope: OfflineBoardScope,
  scopeKey: string,
  options: EnsureHoldIndexOptions,
): Promise<EnsureHoldIndexResult> {
  const { parseHoldRows, sweepOrphans = false } = options;
  const shouldContinue = options.shouldContinue ?? (() => true);
  const chunkClimbs = Math.max(1, Math.min(options.chunkClimbs ?? HOLD_INDEX_CHUNK_CLIMBS, HOLD_INDEX_CHUNK_CLIMBS));
  const result: EnsureHoldIndexResult = {
    status: 'complete',
    climbsProcessed: 0,
    rowsInserted: 0,
    rowsDeleted: 0,
    chunks: 0,
  };

  if (!(await isScopeDownloadComplete(db, scopeKey))) return { ...result, status: 'not-downloaded' };

  const filter = climbsScopeFilter(scope);
  const uuidWalkFilter = climbsScopeFilter(scope, '+');
  const insertChunkRows = multiRowChunkSize(HOLD_COLUMNS.length);
  let rawWatermark = await readRawWatermark(db, scopeKey);

  /**
   * One short IMMEDIATE transaction: replace `climbs`' hold rows and move the
   * watermark to `next`, but only if the scope is still downloaded and nobody
   * moved the watermark since `rawWatermark` was read. `climbs` may be empty (a
   * phase transition). Returns false when the chunk was dropped.
   */
  const commitChunk = async (climbs: readonly ClimbChunkRow[], next: HoldIndexWatermark): Promise<boolean> => {
    const values: SqlValue[] = [];
    for (const climb of climbs) {
      if (!isIndexable(climb)) continue;
      for (const hold of parseHoldRows(scope.boardType, climb.frames ?? '')) {
        values.push(scope.boardType, climb.uuid, hold.holdId, hold.holdState);
      }
    }
    if (!shouldContinue()) return false;

    const expectedRaw = rawWatermark;
    const nextRaw = JSON.stringify(next);
    let chunkDeleted = 0;
    try {
      await runPullWrite(db, async (transaction) => {
        chunkDeleted = 0;
        // Under the lock: a teardown or sign-out that committed since the read
        // took the scope-complete marker and our watermark with it. Writing now
        // would leave rows for climbs that are gone and a watermark that makes a
        // re-download skip them.
        if (!shouldContinue() || !(await isScopeDownloadComplete(transaction, scopeKey))) {
          throw new HoldIndexChunkAbortedError();
        }
        if ((await readRawWatermark(transaction, scopeKey)) !== expectedRaw) throw new HoldIndexChunkAbortedError();

        if (climbs.length > 0) {
          const uuids = climbs.map((climb) => climb.uuid);
          const deleteResult = await transaction.runAsync(
            `DELETE FROM board_climb_holds WHERE board_type = ? AND climb_uuid IN (${placeholders(uuids.length)})`,
            [scope.boardType, ...uuids],
          );
          chunkDeleted = deleteResult.changes;
        }

        const rowCount = values.length / HOLD_COLUMNS.length;
        for (let startRow = 0; startRow < rowCount; startRow += insertChunkRows) {
          const rowsInStatement = Math.min(insertChunkRows, rowCount - startRow);
          await transaction.runAsync(
            buildMultiRowInsertSql('board_climb_holds', HOLD_COLUMNS, rowsInStatement),
            values.slice(startRow * HOLD_COLUMNS.length, (startRow + rowsInStatement) * HOLD_COLUMNS.length),
          );
        }

        await transaction.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
          holdIndexKey(scopeKey),
          nextRaw,
        ]);
      });
    } catch (error) {
      if (error instanceof HoldIndexChunkAbortedError) return false;
      throw error;
    }

    rawWatermark = nextRaw;
    if (climbs.length > 0) result.chunks += 1;
    result.climbsProcessed += climbs.length;
    result.rowsInserted += values.length / HOLD_COLUMNS.length;
    result.rowsDeleted += chunkDeleted;
    return true;
  };

  let watermark: HoldIndexWatermark | null = parseWatermark(rawWatermark);

  // FIRST BUILD: walk the scope in uuid order. The primary key leads with
  // (board_type, climb_uuid), so inserting climbs in uuid order appends to the
  // b-tree instead of touching a random leaf page per climb. Walking in sync_seq
  // order (random uuids) made every late chunk rewrite ~1,000 scattered pages:
  // about 0.8 GB of WAL for one MoonBoard layout.
  if (!watermark) {
    if (!shouldContinue()) return { ...result, status: 'aborted' };
    const target = await db.getFirstAsync<{ max_seq: number | null }>(
      `SELECT MAX(sync_seq) AS max_seq FROM board_climbs WHERE ${filter.sql}`,
      filter.params,
    );
    watermark = { phase: 'initial', lastUuid: null, targetSyncSeq: target?.max_seq ?? -1 };
    // Stamped before the first chunk so a killed app resumes the walk rather
    // than starting a new one with a different target.
    if (!(await commitChunk([], watermark))) return { ...result, status: 'aborted' };
  }

  while (watermark.phase === 'initial') {
    if (!shouldContinue()) return { ...result, status: 'aborted' };
    const { lastUuid, targetSyncSeq }: { lastUuid: string | null; targetSyncSeq: number } = watermark;
    // `uuidWalkFilter` prefixes every scope column with a unary `+`, which stops
    // SQLite from using an index on it. Without that the planner picks
    // idx_climbs_sync_seq and sorts the whole scope for every chunk (~300 ms on a
    // Kilter layout); with it, `uuid > ?` walks the uuid primary key in order and
    // stops at the chunk's 500th match, so the whole walk reads the table once.
    const climbs: ClimbChunkRow[] = await db.getAllAsync<ClimbChunkRow>(
      `SELECT ${CLIMB_CHUNK_COLUMNS}
       FROM board_climbs
       WHERE uuid > ? AND ${uuidWalkFilter.sql} AND +sync_seq IS NOT NULL
       ORDER BY uuid
       LIMIT ?`,
      [lastUuid ?? '', ...uuidWalkFilter.params, chunkClimbs],
    );
    const walkDone: boolean = climbs.length < chunkClimbs;
    const next: HoldIndexWatermark = walkDone
      ? { phase: 'incremental', syncSeq: targetSyncSeq, updatedAt: null }
      : { phase: 'initial', lastUuid: climbs[climbs.length - 1].uuid, targetSyncSeq };
    if (!(await commitChunk(climbs, next))) return { ...result, status: 'aborted' };
    watermark = next;
  }

  // INCREMENTAL: everything newer than the watermark, in sync_seq order.
  let syncSeq: number = watermark.syncSeq;
  for (;;) {
    if (!shouldContinue()) return { ...result, status: 'aborted' };
    const climbs: ClimbChunkRow[] = await db.getAllAsync<ClimbChunkRow>(
      `SELECT ${CLIMB_CHUNK_COLUMNS}
       FROM board_climbs
       WHERE ${filter.sql} AND sync_seq > ?
       ORDER BY sync_seq
       LIMIT ?`,
      [...filter.params, syncSeq, chunkClimbs],
    );
    if (climbs.length === 0) break;
    const lastClimb: ClimbChunkRow = climbs[climbs.length - 1];
    const next: HoldIndexWatermark = {
      phase: 'incremental',
      syncSeq: lastClimb.sync_seq,
      updatedAt: lastClimb.updated_at,
    };
    if (!(await commitChunk(climbs, next))) return { ...result, status: 'aborted' };
    syncSeq = next.syncSeq;
    if (climbs.length < chunkClimbs) break;
  }

  if (sweepOrphans && shouldContinue()) {
    result.rowsDeleted += await sweepOrphanRows(db, scope.boardType);
  }
  return result;
}

// One build per scope at a time. The pull cycle and a local reader can both ask
// for the same scope; the second joins the first instead of racing it for the
// write lock and re-deriving the same chunk.
const inFlightBuilds = new Map<string, Promise<EnsureHoldIndexResult>>();

/**
 * Bring one downloaded scope's holds index up to date, in short chunks.
 *
 * Idempotent and resumable: a second call with nothing new is one probe, and a
 * call interrupted anywhere resumes from the last committed chunk. Never call it
 * inside a transaction — it opens its own, one per chunk.
 *
 * Joining an in-flight build returns that build's result, unless it was aborted
 * (its owner's `shouldContinue` said stop, which says nothing about this caller)
 * or this caller asked for `sweepOrphans`, which the running build may not have
 * been asked for. Those callers wait for it and then run their own pass, which
 * starts from the watermark the first one left.
 */
export async function ensureHoldIndex(
  db: OfflineDatabase,
  scope: OfflineBoardScope,
  options: EnsureHoldIndexOptions,
): Promise<EnsureHoldIndexResult> {
  const scopeKey = offlineBoardKey(scope);
  let result: EnsureHoldIndexResult | null = null;
  for (;;) {
    const running = inFlightBuilds.get(scopeKey);
    if (!running) break;
    // A build that threw is its owner's error to report; this caller retries.
    const joined = await running.catch(() => null);
    if (joined && joined.status !== 'aborted' && !options.sweepOrphans) {
      result = joined;
      break;
    }
  }
  if (!result) {
    // No await between the empty-map check above and this set, so two callers
    // can never both start a build for one scope.
    const started = buildHoldIndex(db, scope, scopeKey, options);
    inFlightBuilds.set(scopeKey, started);
    try {
      result = await started;
    } finally {
      if (inFlightBuilds.get(scopeKey) === started) inFlightBuilds.delete(scopeKey);
    }
  }

  if (options.queryClient && result.rowsInserted + result.rowsDeleted > 0) {
    for (const key of invalidateKeysForTable('board_climb_holds') ?? []) {
      options.queryClient.invalidateQueries({ queryKey: key });
    }
  }
  return result;
}
