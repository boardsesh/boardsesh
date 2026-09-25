// Binary formats and read helpers for the device-derived holds index.
//
// The index is two packed-blob tables rather than one row per hold, because one
// row per hold is ~3.8M rows and ~370 MB on a single Kilter download:
//
//  - `board_climb_hold_sets` — one row per indexed climb: its holds, sorted by
//    hold id, 5 bytes each (little-endian uint32 hold id + uint8 role code).
//  - `board_climb_hold_postings` — one row per (board, layout, hold): the local
//    climb ids (`holds_index_climbs.id`) that use the hold, sorted, little-endian
//    uint32 each.
//
// Everything that knows the byte layout lives in this file, so the similar-climbs
// and heatmap readers never touch it. Pure TS: no platform APIs beyond DataView.

import type { SqlExecutor } from '../database';

/** Bytes per hold in a hold-set blob: uint32 hold id + uint8 role. */
export const HOLD_SET_ENTRY_BYTES = 5;
/** Bytes per climb id in a postings blob. */
export const POSTING_ENTRY_BYTES = 4;

/** Role codes stored in a hold-set blob. */
export const HOLD_ROLE = { STARTING: 0, HAND: 1, FOOT: 2, FINISH: 3 } as const;
/**
 * Any other state a board's role table names (Kilter's AUX, for example). The
 * hold still counts for similarity and heatmap `uses`; it just has no role bucket.
 */
export const HOLD_ROLE_OTHER = 255;

export type HoldRole = number;
export type HoldSetEntry = { holdId: number; role: HoldRole };

/** Canonical hold state name → the role code stored on disk. */
export function holdStateToRole(holdState: string): HoldRole {
  switch (holdState) {
    case 'STARTING':
      return HOLD_ROLE.STARTING;
    case 'HAND':
      return HOLD_ROLE.HAND;
    case 'FOOT':
      return HOLD_ROLE.FOOT;
    case 'FINISH':
      return HOLD_ROLE.FINISH;
    default:
      return HOLD_ROLE_OTHER;
  }
}

/**
 * Encode a climb's holds. Sorted by hold id; a repeated hold keeps its FIRST
 * entry, matching Postgres' `ON CONFLICT DO NOTHING` (the parser already
 * dedupes, this makes the format safe on its own).
 */
export function encodeHoldSet(entries: readonly HoldSetEntry[]): Uint8Array {
  const firstByHold = new Map<number, HoldRole>();
  for (const { holdId, role } of entries) {
    if (!firstByHold.has(holdId)) firstByHold.set(holdId, role);
  }
  const holdIds = [...firstByHold.keys()].sort((left, right) => left - right);
  const bytes = new Uint8Array(holdIds.length * HOLD_SET_ENTRY_BYTES);
  const view = new DataView(bytes.buffer);
  holdIds.forEach((holdId, index) => {
    const offset = index * HOLD_SET_ENTRY_BYTES;
    view.setUint32(offset, holdId, true);
    view.setUint8(offset + 4, firstByHold.get(holdId) ?? HOLD_ROLE_OTHER);
  });
  return bytes;
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Number of holds in a hold-set blob. */
export function holdSetSize(bytes: Uint8Array): number {
  return Math.floor(bytes.byteLength / HOLD_SET_ENTRY_BYTES);
}

/** Hold id of the `index`th entry of a hold-set blob. */
export function holdSetHoldIdAt(bytes: Uint8Array, index: number): number {
  return viewOf(bytes).getUint32(index * HOLD_SET_ENTRY_BYTES, true);
}

export function decodeHoldSet(bytes: Uint8Array): HoldSetEntry[] {
  const view = viewOf(bytes);
  const count = holdSetSize(bytes);
  const entries: HoldSetEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = index * HOLD_SET_ENTRY_BYTES;
    entries.push({ holdId: view.getUint32(offset, true), role: view.getUint8(offset + 4) });
  }
  return entries;
}

/** Just the hold ids of a hold-set blob, ascending. */
export function decodeHoldSetIds(bytes: Uint8Array): Uint32Array {
  const view = viewOf(bytes);
  const ids = new Uint32Array(holdSetSize(bytes));
  for (let index = 0; index < ids.length; index += 1) ids[index] = view.getUint32(index * HOLD_SET_ENTRY_BYTES, true);
  return ids;
}

/** Encode climb ids, which must already be sorted ascending and unique. */
export function encodePostings(sortedClimbIds: ArrayLike<number>): Uint8Array {
  const bytes = new Uint8Array(sortedClimbIds.length * POSTING_ENTRY_BYTES);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < sortedClimbIds.length; index += 1) {
    view.setUint32(index * POSTING_ENTRY_BYTES, sortedClimbIds[index], true);
  }
  return bytes;
}

export function decodePostings(bytes: Uint8Array): Uint32Array {
  const view = viewOf(bytes);
  const ids = new Uint32Array(Math.floor(bytes.byteLength / POSTING_ENTRY_BYTES));
  for (let index = 0; index < ids.length; index += 1) ids[index] = view.getUint32(index * POSTING_ENTRY_BYTES, true);
  return ids;
}

/**
 * Apply sorted-set edits to a postings blob: `remove` and `add` are climb ids in
 * any order. One linear merge; returns null when nothing changed.
 */
export function editPostings(
  bytes: Uint8Array | null,
  add: ReadonlySet<number>,
  remove: ReadonlySet<number>,
): Uint8Array | null {
  const current = bytes ? decodePostings(bytes) : new Uint32Array(0);
  const additions = [...add].filter((id) => !remove.has(id)).sort((left, right) => left - right);
  const merged: number[] = [];
  let changed = false;
  let addIndex = 0;
  for (let index = 0; index < current.length; index += 1) {
    const id = current[index];
    while (addIndex < additions.length && additions[addIndex] < id) {
      merged.push(additions[addIndex]);
      addIndex += 1;
      changed = true;
    }
    if (addIndex < additions.length && additions[addIndex] === id) addIndex += 1;
    if (remove.has(id)) {
      changed = true;
      continue;
    }
    merged.push(id);
  }
  for (; addIndex < additions.length; addIndex += 1) {
    merged.push(additions[addIndex]);
    changed = true;
  }
  return changed ? encodePostings(merged) : null;
}

function asBytes(value: unknown): Uint8Array | null {
  return value instanceof Uint8Array ? value : null;
}

/** A climb's indexed holds, or null when the climb is not in the index. */
export async function getHoldSet(db: SqlExecutor, uuid: string): Promise<HoldSetEntry[] | null> {
  const row = await db.getFirstAsync<{ holds: unknown }>(
    `SELECT hs.holds FROM holds_index_climbs hic
     JOIN board_climb_hold_sets hs ON hs.climb_id = hic.id
     WHERE hic.uuid = ?`,
    [uuid],
  );
  const bytes = asBytes(row?.holds);
  return bytes ? decodeHoldSet(bytes) : null;
}

export type SimilarClimbCandidate = {
  uuid: string;
  /** Distinct holds shared with the target. */
  shared: number;
  /** Distinct holds on the candidate. */
  candidateSize: number;
  /** shared / (target + candidate - shared). */
  jaccard: number;
};

const IN_LIST_BATCH = 900;

/**
 * Climbs of one layout whose holds overlap the target's with Jaccard ≥ threshold,
 * best first (jaccard desc, then shared desc, then uuid). Roles are ignored, as
 * in the server's `findSimilarClimbs`.
 *
 * Returns up to `limit * 4` so the caller can still fill `limit` after applying
 * the board_climbs / stats predicates this index does not know (listed, size
 * scope, frames_count, angle). A posting may briefly name a climb whose hold set
 * is gone (a tombstone racing a rebuild); such ids are dropped here.
 */
export async function findSimilarClimbCandidates(
  db: SqlExecutor,
  params: {
    boardType: string;
    layoutId: number;
    targetHoldIds: readonly number[];
    threshold: number;
    excludeUuid?: string | null;
    limit: number;
  },
): Promise<SimilarClimbCandidate[]> {
  const targetHoldIds = [...new Set(params.targetHoldIds)];
  const targetSize = targetHoldIds.length;
  if (targetSize === 0 || params.limit <= 0) return [];

  const postings: Uint32Array[] = [];
  let maxId = 0;
  for (let start = 0; start < targetHoldIds.length; start += IN_LIST_BATCH) {
    const batch = targetHoldIds.slice(start, start + IN_LIST_BATCH);
    const rows = await db.getAllAsync<{ climb_ids: unknown }>(
      `SELECT climb_ids FROM board_climb_hold_postings
       WHERE board_type = ? AND layout_id = ? AND hold_id IN (${batch.map(() => '?').join(', ')})`,
      [params.boardType, params.layoutId, ...batch],
    );
    for (const row of rows) {
      const bytes = asBytes(row.climb_ids);
      if (!bytes || bytes.byteLength === 0) continue;
      const ids = decodePostings(bytes);
      postings.push(ids);
      maxId = Math.max(maxId, ids[ids.length - 1]);
    }
  }
  if (postings.length === 0) return [];

  // Local ids are dense (an autoincrementing rowid), so a typed array indexed by
  // id counts overlaps without a hash map. One uint8 per id is enough: a target
  // has far fewer than 256 holds.
  const counts = new Uint8Array(maxId + 1);
  for (const ids of postings) {
    for (let index = 0; index < ids.length; index += 1) counts[ids[index]] += 1;
  }

  let excludeId = -1;
  if (params.excludeUuid) {
    const row = await db.getFirstAsync<{ id: number }>('SELECT id FROM holds_index_climbs WHERE uuid = ?', [
      params.excludeUuid,
    ]);
    excludeId = row?.id ?? -1;
  }

  // Jaccard ≥ t needs shared ≥ t × |target| (the union is at least the target).
  const minimumShared = Math.max(1, Math.ceil(targetSize * params.threshold));
  const survivors: number[] = [];
  for (let id = 0; id < counts.length; id += 1) {
    if (counts[id] >= minimumShared && id !== excludeId) survivors.push(id);
  }

  const candidates: SimilarClimbCandidate[] = [];
  for (let start = 0; start < survivors.length; start += IN_LIST_BATCH) {
    const batch = survivors.slice(start, start + IN_LIST_BATCH);
    const rows = await db.getAllAsync<{ climb_id: number; uuid: string; hold_bytes: number }>(
      `SELECT hs.climb_id, hic.uuid, length(hs.holds) AS hold_bytes
       FROM board_climb_hold_sets hs JOIN holds_index_climbs hic ON hic.id = hs.climb_id
       WHERE hs.climb_id IN (${batch.map(() => '?').join(', ')})`,
      batch,
    );
    for (const row of rows) {
      const shared = counts[row.climb_id];
      const candidateSize = Math.floor(row.hold_bytes / HOLD_SET_ENTRY_BYTES);
      const jaccard = shared / (targetSize + candidateSize - shared);
      if (jaccard >= params.threshold) candidates.push({ uuid: row.uuid, shared, candidateSize, jaccard });
    }
  }

  candidates.sort(
    (left, right) =>
      right.jaccard - left.jaccard ||
      right.shared - left.shared ||
      (left.uuid < right.uuid ? -1 : left.uuid > right.uuid ? 1 : 0),
  );
  return candidates.slice(0, params.limit * 4);
}

export type HoldUsage = {
  /** Climbs using the hold. */
  uses: number;
  /** Climbs using it as STARTING, HAND, FOOT, FINISH (HOLD_ROLE order). */
  byRole: [number, number, number, number];
  /** Sum of the climbs' ascent counts (null counts as 0). */
  ascentsSum: number;
  /** Sum and count of non-null difficulties, for an average. */
  difficultySum: number;
  difficultyCount: number;
};

/**
 * Per-hold usage over a set of climbs — the heatmap's aggregate, done in JS over
 * hold-set blobs instead of a GROUP BY over per-hold rows. Feed it the rows of a
 * query joining the filtered climbs to `board_climb_hold_sets`.
 */
export function aggregateHoldUsage(
  rows: Iterable<{ holds: Uint8Array; ascents?: number | null; difficulty?: number | null }>,
): Map<number, HoldUsage> {
  const usage = new Map<number, HoldUsage>();
  for (const { holds, ascents, difficulty } of rows) {
    const view = viewOf(holds);
    const count = holdSetSize(holds);
    for (let index = 0; index < count; index += 1) {
      const offset = index * HOLD_SET_ENTRY_BYTES;
      const holdId = view.getUint32(offset, true);
      const role = view.getUint8(offset + 4);
      let entry = usage.get(holdId);
      if (!entry) {
        entry = { uses: 0, byRole: [0, 0, 0, 0], ascentsSum: 0, difficultySum: 0, difficultyCount: 0 };
        usage.set(holdId, entry);
      }
      entry.uses += 1;
      if (role < 4) entry.byRole[role] += 1;
      entry.ascentsSum += ascents ?? 0;
      if (difficulty !== null && difficulty !== undefined) {
        entry.difficultySum += difficulty;
        entry.difficultyCount += 1;
      }
    }
  }
  return usage;
}
