// The device-derived holds index, built on the phone from the `frames` string
// every downloaded climb already carries.
//
// Two local readers need to go from holds to climbs: similar climbs ("which
// climbs share these holds?") and the hold heatmap ("how often is each hold
// used?"). Neither can afford to ask Postgres. The frames are already on disk,
// so the index is derived here instead of downloaded.
//
// Storage is packed blobs, not one row per hold (holds-index/query.ts has the
// byte formats):
//   holds_index_climbs        uuid → stable local integer id
//   board_climb_hold_sets     climb id → its holds (5 bytes per hold)
//   board_climb_hold_postings (board, layout, hold) → sorted climb ids
// One row per hold was ~3.8M rows and ~370 MB on a single Kilter download.
//
// The shape of the build, and why:
//
//  - WATERMARK PER SCOPE, on `sync_seq` only. One `holds-index:<scopeKey>` row in
//    sync_meta per downloaded (boardType, layoutId, sizeId). Per scope rather than
//    per layout because a second size of a layout imports its own climbs with
//    older `sync_seq` values, which a per-layout watermark would skip forever.
//    `sync_seq` is the server's per-row change counter; the client upsert and the
//    snapshot import both preserve it, so "newer than the watermark" is exactly
//    "new or edited since the last build".
//
//  - ONLY COMPLETE SCOPES. A crawl mid-flight delivers rows out of `sync_seq`
//    order, so a watermark taken then could sit above rows not yet delivered. The
//    build needs `scope-complete:` and re-checks it under every write lock, which
//    also keeps it safe from a teardown landing between chunks: the teardown
//    deletes that marker in the same transaction as the index rows.
//
//  - FIRST BUILD, then INCREMENTAL. With no watermark, the build records the
//    scope's MAX(sync_seq), walks the scope in uuid order (so new local ids and
//    their uuid index append rather than scatter), writes hold sets in short
//    2,000-climb transactions, then rebuilds the layout's postings from every
//    hold set of that layout and stamps the watermark at the recorded value. A
//    first build that is interrupted starts again from the top: hold-set writes
//    skip unchanged rows, and the postings rebuild reads the truth, so nothing is
//    lost. After that, climbs past the watermark are re-derived 500 at a time,
//    each chunk editing only the postings its climbs enter or leave.
//
//  - ONLY LISTED, PUBLISHED, NOT HIDDEN climbs are indexed. Neither reader shows
//    anything else. A climb that flips hidden gets a new `sync_seq`, is re-read,
//    and leaves the index.
//
//  - POSTINGS ARE PER LAYOUT, shared by every downloaded size of it, so builds are
//    single-flighted per layout, and a teardown clears the whole layout's index
//    and every sibling scope's watermark (the survivors rebuild next cycle).
//
// The frames parser is INJECTED (`HoldRowParser`): this package has zero runtime
// dependencies by contract, and the parser lives in @boardsesh/board-constants.

import type { OfflineDatabase, QueryInvalidator, SqlExecutor, SqlValue } from '../database';
import { offlineBoardKey, type OfflineBoardScope } from '../offline-board-key';
import { climbsScopeFilter } from '../sync/board-scope-sql';
import { isScopeDownloadComplete } from '../sync/checkpoints';
import { invalidateKeysForTable, scopedInvalidateFilters } from '../sync/invalidate-keys';
import { runPullWrite } from '../sync/pull-write';
import { decodeHoldSetIds, editPostings, encodeHoldSet, encodePostings, holdStateToRole } from './query';

/** One parsed hold: a hold a climb lights, and the role it lights it in. */
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
   * Checked before every chunk and again under its write lock. Returning false
   * stops the build: the chunk in hand is dropped and the watermark stays where
   * it was (an interrupted first build simply starts over next time).
   */
  shouldContinue?: () => boolean;
  /**
   * Remove index entries whose climb is gone. Only needed after a snapshot
   * import, whose reconcile step deletes local climbs without a tombstone.
   */
  sweepOrphans?: boolean;
  /** When given, the holds-index query keys are invalidated after the index changed. */
  queryClient?: QueryInvalidator;
  /** Climbs per incremental chunk (default HOLD_INDEX_CHUNK_CLIMBS); a test seam. */
  chunkClimbs?: number;
  /** Climbs per first-build chunk (default HOLD_INDEX_INITIAL_CHUNK_CLIMBS); a test seam. */
  initialChunkClimbs?: number;
  /**
   * Hands the JS thread back between chunks, so parsing 2,000 climbs never runs
   * back to back with the next 2,000 and starves rendering and gestures. Defaults
   * to one macrotask (`setTimeout(0)`).
   */
  yieldToHost?: () => Promise<void>;
};

export type EnsureHoldIndexResult = {
  /**
   * `complete` — the index covers every climb of the scope.
   * `aborted` — `shouldContinue` said stop, or the scope changed under the build.
   * `not-downloaded` — the scope has no `scope-complete:` marker, so nothing ran.
   */
  status: 'complete' | 'aborted' | 'not-downloaded';
  /** Climbs read from `board_climbs` and committed. */
  climbsProcessed: number;
  /** Hold-set rows inserted or changed. */
  holdSetsWritten: number;
  /** Hold-set rows removed (climb hidden, unlisted, drafted or gone). */
  holdSetsDeleted: number;
  /** Posting rows written or removed. */
  postingsWritten: number;
  /** Climb chunks committed. */
  chunks: number;
};

/** Climbs per incremental chunk: one short write each. */
export const HOLD_INDEX_CHUNK_CLIMBS = 500;
/** Climbs per first-build chunk: hold sets only, so a bigger chunk is still short. */
export const HOLD_INDEX_INITIAL_CHUNK_CLIMBS = 2000;
/** Posting rows per transaction when a layout's postings are rebuilt. */
const POSTINGS_WRITE_BATCH_HOLDS = 200;
/** Ids per `IN (...)` list, under SQLite's 999 bind floor. */
const IN_LIST_BATCH = 900;

/** Prefix of the per-scope watermark key in sync_meta. */
export const HOLD_INDEX_KEY_PREFIX = 'holds-index:';

/** The sync_meta key holding one scope's holds-index watermark. */
export function holdIndexKey(scopeKey: string): string {
  return `${HOLD_INDEX_KEY_PREFIX}${scopeKey}`;
}

/**
 * Prefix of the teardown generation counters in sync_meta: one per layout
 * (`<prefix><boardType>:<layoutId>`) and one per board type (`<prefix><boardType>`).
 * Every clear of the index bumps them. A build reads them when it starts and
 * re-reads them under each write lock, so a teardown that lands mid-build (even
 * one of a SIBLING size, which leaves this scope's own markers alone) stops it
 * before it can write rows from a read that predates the wipe.
 *
 * Deliberately not per scope and not in `scopeSyncMetaKeys`: the counter must
 * outlive the teardown that bumps it.
 */
export const HOLD_INDEX_GENERATION_PREFIX = 'holds-index-generation:';

function layoutGenerationKey(boardType: string, layoutId: number): string {
  return `${HOLD_INDEX_GENERATION_PREFIX}${boardType}:${layoutId}`;
}

function boardTypeGenerationKey(boardType: string): string {
  return `${HOLD_INDEX_GENERATION_PREFIX}${boardType}`;
}

async function bumpGeneration(txn: SqlExecutor, key: string): Promise<void> {
  await txn.runAsync(
    `INSERT INTO sync_meta (key, value) VALUES (?, '1')
     ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
    [key],
  );
}

async function readGeneration(db: SqlExecutor, boardType: string, layoutId: number): Promise<string> {
  const rows = await db.getAllAsync<{ key: string; value: string }>(
    'SELECT key, value FROM sync_meta WHERE key IN (?, ?) ORDER BY key',
    [layoutGenerationKey(boardType, layoutId), boardTypeGenerationKey(boardType)],
  );
  return rows.map((row) => `${row.key}=${row.value}`).join(';');
}

const defaultYieldToHost = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Row counts one write transaction produced; merged into the result only once it commits. */
type WriteTally = { holdSetsWritten: number; holdSetsDeleted: number; postingsWritten: number };

/** A posting list under construction: a growable uint32 buffer, 4 bytes per id. */
type GrowingPosting = { ids: Uint32Array; length: number };

function appendToPosting(posting: GrowingPosting, climbId: number): void {
  if (posting.length === posting.ids.length) {
    const grown = new Uint32Array(Math.max(16, posting.ids.length * 2));
    grown.set(posting.ids);
    posting.ids = grown;
  }
  posting.ids[posting.length] = climbId;
  posting.length += 1;
}

type HoldIndexWatermark = { syncSeq: number; updatedAt: string | null };

class HoldIndexChunkAbortedError extends Error {}

function parseWatermark(raw: string | null): HoldIndexWatermark | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { syncSeq, updatedAt } = parsed as { syncSeq?: unknown; updatedAt?: unknown };
    if (typeof syncSeq !== 'number' || !Number.isFinite(syncSeq)) return null;
    return { syncSeq, updatedAt: typeof updatedAt === 'string' ? updatedAt : null };
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
 * Is there any climb in this scope the index does not cover? No watermark (never
 * built, or a first build still running) is behind by definition; otherwise one
 * indexed probe on `idx_climbs_sync_seq`, cheap enough before every local read.
 * Says nothing about whether the scope is downloaded; `ensureHoldIndex` checks that.
 */
export async function isHoldIndexBehind(db: SqlExecutor, scope: OfflineBoardScope): Promise<boolean> {
  const watermark = parseWatermark(await readRawWatermark(db, offlineBoardKey(scope)));
  if (!watermark) return true;
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

type PostingEdit = { add: Set<number>; remove: Set<number> };

const CLIMB_CHUNK_COLUMNS = 'uuid, frames, updated_at, sync_seq, is_listed, is_draft, is_hidden';

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function bytesEqual(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === right) return true;
  if (!left || !right || left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function asBytes(value: unknown): Uint8Array | null {
  return value instanceof Uint8Array ? value : null;
}

/** The climb's hold-set blob, or null when it must not be indexed (or lights nothing). */
function deriveHoldSet(boardType: string, climb: ClimbChunkRow, parseHoldRows: HoldRowParser): Uint8Array | null {
  const indexable = climb.is_listed === 1 && climb.is_draft === 0 && (climb.is_hidden ?? 0) === 0;
  if (!indexable) return null;
  const holds = parseHoldRows(boardType, climb.frames ?? '');
  if (holds.length === 0) return null;
  return encodeHoldSet(holds.map(({ holdId, holdState }) => ({ holdId, role: holdStateToRole(holdState) })));
}

/** Local ids for `uuids`, creating the missing ones. Must run inside the write transaction. */
async function ensureClimbIds(txn: SqlExecutor, uuids: readonly string[]): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  for (let start = 0; start < uuids.length; start += IN_LIST_BATCH) {
    const batch = uuids.slice(start, start + IN_LIST_BATCH);
    await txn.runAsync(
      `INSERT OR IGNORE INTO holds_index_climbs (uuid) VALUES ${batch.map(() => '(?)').join(', ')}`,
      batch,
    );
    const rows = await txn.getAllAsync<{ id: number; uuid: string }>(
      `SELECT id, uuid FROM holds_index_climbs WHERE uuid IN (${placeholders(batch.length)})`,
      batch,
    );
    for (const row of rows) ids.set(row.uuid, row.id);
  }
  return ids;
}

async function readHoldSets(executor: SqlExecutor, climbIds: readonly number[]): Promise<Map<number, Uint8Array>> {
  const sets = new Map<number, Uint8Array>();
  for (let start = 0; start < climbIds.length; start += IN_LIST_BATCH) {
    const batch = climbIds.slice(start, start + IN_LIST_BATCH);
    const rows = await executor.getAllAsync<{ climb_id: number; holds: unknown }>(
      `SELECT climb_id, holds FROM board_climb_hold_sets WHERE climb_id IN (${placeholders(batch.length)})`,
      batch,
    );
    for (const row of rows) {
      const bytes = asBytes(row.holds);
      if (bytes) sets.set(row.climb_id, bytes);
    }
  }
  return sets;
}

async function readPosting(
  txn: SqlExecutor,
  boardType: string,
  layoutId: number,
  holdId: number,
): Promise<Uint8Array | null> {
  const row = await txn.getFirstAsync<{ climb_ids: unknown }>(
    'SELECT climb_ids FROM board_climb_hold_postings WHERE board_type = ? AND layout_id = ? AND hold_id = ?',
    [boardType, layoutId, holdId],
  );
  return asBytes(row?.climb_ids);
}

async function writePosting(
  txn: SqlExecutor,
  boardType: string,
  layoutId: number,
  holdId: number,
  climbIds: Uint8Array,
): Promise<void> {
  if (climbIds.byteLength === 0) {
    await txn.runAsync('DELETE FROM board_climb_hold_postings WHERE board_type = ? AND layout_id = ? AND hold_id = ?', [
      boardType,
      layoutId,
      holdId,
    ]);
    return;
  }
  await txn.runAsync(
    'INSERT OR REPLACE INTO board_climb_hold_postings (board_type, layout_id, hold_id, climb_ids) VALUES (?, ?, ?, ?)',
    [boardType, layoutId, holdId, climbIds],
  );
}

/**
 * Take one climb out of the index: drop its id from every posting its hold set
 * names, then drop the hold set. The `board_climbs` tombstone cascade calls this
 * inside its own transaction. The `holds_index_climbs` row stays: an id never
 * changes meaning, and a reused uuid gets its old id back.
 */
export async function removeClimbFromHoldIndex(
  txn: SqlExecutor,
  climb: { uuid: string; boardType: string; layoutId: number },
): Promise<boolean> {
  const idRow = await txn.getFirstAsync<{ id: number }>('SELECT id FROM holds_index_climbs WHERE uuid = ?', [
    climb.uuid,
  ]);
  if (!idRow) return false;
  const holdSet = (await readHoldSets(txn, [idRow.id])).get(idRow.id);
  if (!holdSet) return false;
  const remove = new Set([idRow.id]);
  for (const holdId of decodeHoldSetIds(holdSet)) {
    const edited = editPostings(await readPosting(txn, climb.boardType, climb.layoutId, holdId), new Set(), remove);
    if (edited) await writePosting(txn, climb.boardType, climb.layoutId, holdId, edited);
  }
  await txn.runAsync('DELETE FROM board_climb_hold_sets WHERE climb_id = ?', [idRow.id]);
  return true;
}

/**
 * Clear one layout's whole index — its climbs' hold sets, its postings, and the
 * watermark of EVERY scope of the layout — inside the caller's transaction.
 * Scope teardown runs it before deleting the climbs (the hold sets are found
 * through them). Postings are shared by sibling sizes, so a surviving sibling
 * loses its index too and rebuilds it on its next cycle.
 */
export async function clearLayoutHoldIndex(txn: SqlExecutor, boardType: string, layoutId: number): Promise<void> {
  await txn.runAsync(
    `DELETE FROM board_climb_hold_sets WHERE climb_id IN (
       SELECT hic.id FROM holds_index_climbs hic JOIN board_climbs c ON c.uuid = hic.uuid
       WHERE c.board_type = ? AND c.layout_id = ?)`,
    [boardType, layoutId],
  );
  await txn.runAsync('DELETE FROM board_climb_hold_postings WHERE board_type = ? AND layout_id = ?', [
    boardType,
    layoutId,
  ]);
  const prefix = `${HOLD_INDEX_KEY_PREFIX}${boardType}:${layoutId}:`;
  await txn.runAsync('DELETE FROM sync_meta WHERE substr(key, 1, ?) = ?', [prefix.length, prefix]);
  await bumpGeneration(txn, layoutGenerationKey(boardType, layoutId));
}

/**
 * Clear one board type from the index — the spray wipe on sign-out, where a
 * private wall's climbs must not outlive the account. Run it before the board
 * type's climbs are deleted.
 *
 * Takes the board type's hold sets and postings, every hold set whose climb is
 * already gone (a tombstoned or torn-down wall climb, which no join through
 * board_climbs can attribute to a board type any more), and then every local id
 * no hold set still uses. That last sweep is what leaves no spray uuid behind;
 * it is safe for other boards too, because ids are AUTOINCREMENT (a deleted id
 * is never reissued) and a climb that is indexed again simply gets a new one.
 */
export async function clearBoardTypeHoldIndex(txn: SqlExecutor, boardType: string): Promise<void> {
  await txn.runAsync(
    `DELETE FROM board_climb_hold_sets WHERE climb_id IN (
       SELECT hic.id FROM holds_index_climbs hic
       LEFT JOIN board_climbs c ON c.uuid = hic.uuid
       WHERE c.uuid IS NULL OR c.board_type = ?)`,
    [boardType],
  );
  await txn.runAsync(
    'DELETE FROM holds_index_climbs WHERE NOT EXISTS (SELECT 1 FROM board_climb_hold_sets hs WHERE hs.climb_id = holds_index_climbs.id)',
  );
  await txn.runAsync('DELETE FROM board_climb_hold_postings WHERE board_type = ?', [boardType]);
  const prefix = `${HOLD_INDEX_KEY_PREFIX}${boardType}:`;
  await txn.runAsync('DELETE FROM sync_meta WHERE substr(key, 1, ?) = ?', [prefix.length, prefix]);
  await bumpGeneration(txn, boardTypeGenerationKey(boardType));
}

function emptyResult(): EnsureHoldIndexResult {
  return {
    status: 'complete',
    climbsProcessed: 0,
    holdSetsWritten: 0,
    holdSetsDeleted: 0,
    postingsWritten: 0,
    chunks: 0,
  };
}

async function buildHoldIndex(
  db: OfflineDatabase,
  scope: OfflineBoardScope,
  scopeKey: string,
  options: EnsureHoldIndexOptions,
): Promise<EnsureHoldIndexResult> {
  const { parseHoldRows, sweepOrphans = false } = options;
  const { boardType, layoutId } = scope;
  const shouldContinue = options.shouldContinue ?? (() => true);
  const chunkClimbs = Math.max(1, options.chunkClimbs ?? HOLD_INDEX_CHUNK_CLIMBS);
  const initialChunkClimbs = Math.max(1, options.initialChunkClimbs ?? HOLD_INDEX_INITIAL_CHUNK_CLIMBS);
  const yieldToHost = options.yieldToHost ?? defaultYieldToHost;
  const result = emptyResult();
  const aborted = (): EnsureHoldIndexResult => ({ ...result, status: 'aborted' });

  // Read BEFORE anything else: a teardown that lands after this point changes it.
  const generation = await readGeneration(db, boardType, layoutId);
  if (!(await isScopeDownloadComplete(db, scopeKey))) return { ...result, status: 'not-downloaded' };

  const filter = climbsScopeFilter(scope);
  let rawWatermark = await readRawWatermark(db, scopeKey);

  /**
   * One short IMMEDIATE transaction, run only while the scope is still
   * downloaded and nobody has moved the watermark since the build read it. A
   * teardown or sign-out that committed in between took the scope-complete
   * marker (and the index rows) with it; writing now would put rows back for
   * climbs that are gone. A teardown of a sibling size leaves this scope's
   * markers alone but bumps the layout generation, which is checked too.
   * Returns false when the write was dropped.
   *
   * The task counts into a fresh tally per attempt, merged into the result only
   * after the commit, so a write the lock ladder retried is counted once.
   */
  const guardedWrite = async (task: (txn: SqlExecutor, tally: WriteTally) => Promise<void>): Promise<boolean> => {
    if (!shouldContinue()) return false;
    const expectedRaw = rawWatermark;
    let tally: WriteTally = { holdSetsWritten: 0, holdSetsDeleted: 0, postingsWritten: 0 };
    try {
      await runPullWrite(db, async (txn) => {
        tally = { holdSetsWritten: 0, holdSetsDeleted: 0, postingsWritten: 0 };
        if (!shouldContinue() || !(await isScopeDownloadComplete(txn, scopeKey))) {
          throw new HoldIndexChunkAbortedError();
        }
        if ((await readRawWatermark(txn, scopeKey)) !== expectedRaw) throw new HoldIndexChunkAbortedError();
        if ((await readGeneration(txn, boardType, layoutId)) !== generation) throw new HoldIndexChunkAbortedError();
        await task(txn, tally);
      });
      result.holdSetsWritten += tally.holdSetsWritten;
      result.holdSetsDeleted += tally.holdSetsDeleted;
      result.postingsWritten += tally.postingsWritten;
      return true;
    } catch (error) {
      if (error instanceof HoldIndexChunkAbortedError) return false;
      throw error;
    }
  };

  const stampWatermark = async (txn: SqlExecutor, watermark: HoldIndexWatermark): Promise<string> => {
    const raw = JSON.stringify(watermark);
    await txn.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [holdIndexKey(scopeKey), raw]);
    return raw;
  };

  /**
   * Recompute every posting of this layout from the hold sets of the layout's
   * climbs, which are the truth. The read takes no lock and walks the hold-set
   * key in order (the `+` keeps the planner off board_climbs' indexes, which
   * would sort the layout for every batch); the writes go in short batches and
   * skip postings that did not change.
   */
  const rebuildLayoutPostings = async (): Promise<boolean> => {
    const postings = new Map<number, GrowingPosting>();
    let lastClimbId = -1;
    for (;;) {
      await yieldToHost();
      if (!shouldContinue()) return false;
      const rows = await db.getAllAsync<{ climb_id: number; holds: unknown }>(
        `SELECT hs.climb_id, hs.holds
         FROM board_climb_hold_sets hs
         JOIN holds_index_climbs hic ON hic.id = hs.climb_id
         JOIN board_climbs c ON c.uuid = hic.uuid
         WHERE hs.climb_id > ? AND +c.board_type = ? AND +c.layout_id = ?
         ORDER BY hs.climb_id
         LIMIT 5000`,
        [lastClimbId, boardType, layoutId],
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        const bytes = asBytes(row.holds);
        if (!bytes) continue;
        // Rows arrive in climb-id order, so each posting list is built sorted.
        for (const holdId of decodeHoldSetIds(bytes)) {
          let posting = postings.get(holdId);
          if (!posting) {
            posting = { ids: new Uint32Array(16), length: 0 };
            postings.set(holdId, posting);
          }
          appendToPosting(posting, row.climb_id);
        }
      }
      lastClimbId = rows[rows.length - 1].climb_id;
    }

    const holdIds = [...postings.keys()];
    for (let start = 0; start < holdIds.length; start += POSTINGS_WRITE_BATCH_HOLDS) {
      const batch = holdIds.slice(start, start + POSTINGS_WRITE_BATCH_HOLDS);
      await yieldToHost();
      const wrote = await guardedWrite(async (txn, tally) => {
        for (const holdId of batch) {
          const posting = postings.get(holdId);
          const next = encodePostings(posting ? posting.ids.subarray(0, posting.length) : []);
          if (bytesEqual(await readPosting(txn, boardType, layoutId, holdId), next)) continue;
          await writePosting(txn, boardType, layoutId, holdId, next);
          tally.postingsWritten += 1;
        }
      });
      if (!wrote) return false;
    }
    return guardedWrite(async (txn, tally) => {
      const existing = await txn.getAllAsync<{ hold_id: number }>(
        'SELECT hold_id FROM board_climb_hold_postings WHERE board_type = ? AND layout_id = ?',
        [boardType, layoutId],
      );
      for (const { hold_id: holdId } of existing) {
        if (postings.has(holdId)) continue;
        await writePosting(txn, boardType, layoutId, holdId, new Uint8Array(0));
        tally.postingsWritten += 1;
      }
    });
  };

  /**
   * Hold sets for one chunk. Unchanged sets are not rewritten, which keeps a
   * sibling size's first build (mostly the same climbs) close to write-free.
   * Returns the per-hold posting edits the chunk implies.
   *
   * The chunk was read without a lock, so each climb is re-checked under this
   * one: a climb a tombstone deleted since is skipped (writing its hold set
   * would leave an orphan), and so is one whose `sync_seq` moved — its new
   * version is above the watermark and a later pass derives it.
   */
  const writeHoldSets = async (
    txn: SqlExecutor,
    tally: WriteTally,
    chunk: readonly ClimbChunkRow[],
    derived: ReadonlyMap<string, Uint8Array | null>,
  ): Promise<Map<number, PostingEdit>> => {
    const current = new Map<string, number | null>();
    for (let start = 0; start < chunk.length; start += IN_LIST_BATCH) {
      const batch = chunk.slice(start, start + IN_LIST_BATCH).map((climb) => climb.uuid);
      const rows = await txn.getAllAsync<{ uuid: string; sync_seq: number | null }>(
        `SELECT uuid, sync_seq FROM board_climbs WHERE uuid IN (${placeholders(batch.length)})`,
        batch,
      );
      for (const row of rows) current.set(row.uuid, row.sync_seq);
    }
    const climbs = chunk.filter((climb) => current.get(climb.uuid) === climb.sync_seq);
    const edits = new Map<number, PostingEdit>();
    const editFor = (holdId: number): PostingEdit => {
      let edit = edits.get(holdId);
      if (!edit) {
        edit = { add: new Set(), remove: new Set() };
        edits.set(holdId, edit);
      }
      return edit;
    };
    const ids = await ensureClimbIds(
      txn,
      climbs.map((climb) => climb.uuid),
    );
    const existing = await readHoldSets(txn, [...ids.values()]);
    const upserts: SqlValue[] = [];
    const deletes: number[] = [];
    for (const climb of climbs) {
      const climbId = ids.get(climb.uuid);
      if (climbId === undefined) continue;
      const previous = existing.get(climbId) ?? null;
      const next = derived.get(climb.uuid) ?? null;
      if (bytesEqual(previous, next)) continue;
      const previousHolds = previous ? decodeHoldSetIds(previous) : new Uint32Array(0);
      const nextHolds = next ? decodeHoldSetIds(next) : new Uint32Array(0);
      const nextSet = new Set(nextHolds);
      const previousSet = new Set(previousHolds);
      for (const holdId of previousHolds) if (!nextSet.has(holdId)) editFor(holdId).remove.add(climbId);
      for (const holdId of nextHolds) if (!previousSet.has(holdId)) editFor(holdId).add.add(climbId);
      if (next) upserts.push(climbId, next);
      else deletes.push(climbId);
    }
    for (let start = 0; start < upserts.length; start += IN_LIST_BATCH) {
      const batch = upserts.slice(start, start + IN_LIST_BATCH);
      await txn.runAsync(
        `INSERT OR REPLACE INTO board_climb_hold_sets (climb_id, holds) VALUES ${Array.from(
          { length: batch.length / 2 },
          () => '(?, ?)',
        ).join(', ')}`,
        batch,
      );
    }
    for (let start = 0; start < deletes.length; start += IN_LIST_BATCH) {
      const batch = deletes.slice(start, start + IN_LIST_BATCH);
      await txn.runAsync(`DELETE FROM board_climb_hold_sets WHERE climb_id IN (${placeholders(batch.length)})`, batch);
    }
    tally.holdSetsWritten += upserts.length / 2;
    tally.holdSetsDeleted += deletes.length;
    return edits;
  };

  const deriveChunk = (climbs: readonly ClimbChunkRow[]): Map<string, Uint8Array | null> =>
    new Map(climbs.map((climb) => [climb.uuid, deriveHoldSet(boardType, climb, parseHoldRows)]));

  let watermark = parseWatermark(rawWatermark);

  if (!watermark) {
    // FIRST BUILD. Record the scope's newest change first: anything that lands
    // while this runs is above it and belongs to the incremental phase.
    if (!shouldContinue()) return aborted();
    const target = await db.getFirstAsync<{ max_seq: number | null }>(
      `SELECT MAX(sync_seq) AS max_seq FROM board_climbs WHERE ${filter.sql}`,
      filter.params,
    );
    const targetSyncSeq = target?.max_seq ?? -1;
    // A unary `+` on every scope column stops SQLite using an index on it, so the
    // `uuid > ?` range walks the uuid key in order and each chunk stops at its
    // limit. Without it the planner picks idx_climbs_sync_seq and sorts the whole
    // scope for every chunk (~300 ms per chunk on a Kilter layout).
    const uuidWalkFilter = climbsScopeFilter(scope, '+');
    let lastUuid = '';
    for (;;) {
      if (!shouldContinue()) return aborted();
      const climbs = await db.getAllAsync<ClimbChunkRow>(
        `SELECT ${CLIMB_CHUNK_COLUMNS} FROM board_climbs
         WHERE uuid > ? AND ${uuidWalkFilter.sql} AND +sync_seq IS NOT NULL
         ORDER BY uuid LIMIT ?`,
        [lastUuid, ...uuidWalkFilter.params, initialChunkClimbs],
      );
      if (climbs.length === 0) break;
      const derived = deriveChunk(climbs);
      // Postings are not edited here: the rebuild below derives them from every
      // hold set of the layout at once, which is what makes a restart lossless.
      const wrote = await guardedWrite(async (txn, tally) => {
        await writeHoldSets(txn, tally, climbs, derived);
      });
      if (!wrote) return aborted();
      result.chunks += 1;
      result.climbsProcessed += climbs.length;
      lastUuid = climbs[climbs.length - 1].uuid;
      if (climbs.length < initialChunkClimbs) break;
      await yieldToHost();
    }
    if (!(await rebuildLayoutPostings())) return aborted();
    const next: HoldIndexWatermark = { syncSeq: targetSyncSeq, updatedAt: null };
    let stamped = '';
    const wrote = await guardedWrite(async (txn) => {
      stamped = await stampWatermark(txn, next);
    });
    if (!wrote) return aborted();
    rawWatermark = stamped;
    watermark = next;
  }

  // INCREMENTAL: everything newer than the watermark, in sync_seq order, each
  // chunk editing only the postings its climbs enter or leave.
  let syncSeq = watermark.syncSeq;
  for (;;) {
    if (!shouldContinue()) return aborted();
    const climbs = await db.getAllAsync<ClimbChunkRow>(
      `SELECT ${CLIMB_CHUNK_COLUMNS} FROM board_climbs
       WHERE ${filter.sql} AND sync_seq > ?
       ORDER BY sync_seq LIMIT ?`,
      [...filter.params, syncSeq, chunkClimbs],
    );
    if (climbs.length === 0) break;
    const derived = deriveChunk(climbs);
    const lastClimb = climbs[climbs.length - 1];
    const next: HoldIndexWatermark = { syncSeq: lastClimb.sync_seq, updatedAt: lastClimb.updated_at };
    let stamped = '';
    const wrote = await guardedWrite(async (txn, tally) => {
      const edits = await writeHoldSets(txn, tally, climbs, derived);
      for (const [holdId, { add, remove }] of edits) {
        const edited = editPostings(await readPosting(txn, boardType, layoutId, holdId), add, remove);
        if (!edited) continue;
        await writePosting(txn, boardType, layoutId, holdId, edited);
        tally.postingsWritten += 1;
      }
      stamped = await stampWatermark(txn, next);
    });
    if (!wrote) return aborted();
    rawWatermark = stamped;
    syncSeq = next.syncSeq;
    result.chunks += 1;
    result.climbsProcessed += climbs.length;
    if (climbs.length < chunkClimbs) break;
    await yieldToHost();
  }

  if (sweepOrphans && shouldContinue()) {
    // Hold sets whose climb is gone. Found without a lock; deleted in one short
    // transaction that re-checks each one. The postings are then rebuilt for this
    // layout (the one the import reconciled), the simplest correct fix: an
    // orphan id left in ANOTHER layout's posting is harmless, because
    // `findSimilarClimbCandidates` drops ids that have no hold set.
    const orphans = await db.getAllAsync<{ id: number }>(
      `SELECT hic.id FROM holds_index_climbs hic
       JOIN board_climb_hold_sets hs ON hs.climb_id = hic.id
       WHERE NOT EXISTS (SELECT 1 FROM board_climbs c WHERE c.uuid = hic.uuid)`,
    );
    if (orphans.length > 0) {
      const deleted = await guardedWrite(async (txn, tally) => {
        for (let start = 0; start < orphans.length; start += IN_LIST_BATCH) {
          const batch = orphans.slice(start, start + IN_LIST_BATCH).map((orphan) => orphan.id);
          const removed = await txn.runAsync(
            `DELETE FROM board_climb_hold_sets WHERE climb_id IN (${placeholders(batch.length)})
               AND NOT EXISTS (
                 SELECT 1 FROM holds_index_climbs hic JOIN board_climbs c ON c.uuid = hic.uuid
                 WHERE hic.id = board_climb_hold_sets.climb_id)`,
            batch,
          );
          tally.holdSetsDeleted += removed.changes;
        }
      });
      if (!deleted || !(await rebuildLayoutPostings())) return aborted();
    }
  }
  return result;
}

// One build per LAYOUT at a time: postings are shared by every size of a layout,
// so two scopes of one layout must not edit them concurrently. A caller for the
// same scope joins the running build; any other caller waits for it and then
// runs its own pass (usually one probe).
const inFlightBuilds = new Map<string, { scopeKey: string; promise: Promise<EnsureHoldIndexResult> }>();

/**
 * Bring one downloaded scope's holds index up to date, in short chunks.
 *
 * Idempotent and resumable: a second call with nothing new is one probe. Never
 * call it inside a transaction — it opens its own.
 *
 * Joining a build of the same scope returns that build's result, unless it was
 * aborted (its owner's `shouldContinue` says nothing about this caller) or this
 * caller asked for `sweepOrphans`. Those callers wait and then run their own pass.
 */
export async function ensureHoldIndex(
  db: OfflineDatabase,
  scope: OfflineBoardScope,
  options: EnsureHoldIndexOptions,
): Promise<EnsureHoldIndexResult> {
  const scopeKey = offlineBoardKey(scope);
  const layoutKey = `${scope.boardType}:${scope.layoutId}`;
  let result: EnsureHoldIndexResult | null = null;
  for (;;) {
    const running = inFlightBuilds.get(layoutKey);
    if (!running) break;
    // A build that threw is its owner's error to report; this caller retries.
    const joined = await running.promise.catch(() => null);
    if (running.scopeKey === scopeKey && joined && joined.status !== 'aborted' && !options.sweepOrphans) {
      result = joined;
      break;
    }
  }
  if (!result) {
    // No await between the empty-map check above and this set, so two callers
    // can never both start a build for one layout.
    const promise = buildHoldIndex(db, scope, scopeKey, options);
    const entry = { scopeKey, promise };
    inFlightBuilds.set(layoutKey, entry);
    try {
      result = await promise;
    } finally {
      if (inFlightBuilds.get(layoutKey) === entry) inFlightBuilds.delete(layoutKey);
    }
  }

  const changed = result.holdSetsWritten + result.holdSetsDeleted + result.postingsWritten > 0;
  if (options.queryClient && changed) {
    // Scoped to this board, and never cancelling a fetch already in flight: the
    // heatmap's own queryFn runs this very build (it joins it above), so a
    // cancelling refetch would throw away the answer the build was for and
    // start the aggregate over. The in-flight fetch reads the finished index.
    for (const key of invalidateKeysForTable('board_climb_hold_sets') ?? []) {
      options.queryClient.invalidateQueries(scopedInvalidateFilters(key, scope), { cancelRefetch: false });
    }
  }
  return result;
}
