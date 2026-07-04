import type { BoardName } from '@boardsesh/shared-schema';

import { toBoardName } from './board-name';
import type { ClimbCompatibilityInput, BoardCompatibilityTarget } from './types';

/**
 * Parse an Aurora-format climb frames string into an array of hold IDs.
 *
 * Frames look like `p1234r15p5678r12...` where each `p{holdId}r{stateCode}`
 * pair describes a single hold placement. Returns an empty array for
 * empty, malformed, or nullish input.
 */
export function parseClimbFrameHoldIds(frames: string | null | undefined): number[] {
  if (!frames) return [];
  const ids: number[] = [];
  const pattern = /p(\d+)r-?\d+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(frames)) !== null) {
    const id = Number(match[1]);
    if (Number.isFinite(id)) ids.push(id);
  }
  return ids;
}

export type BoardCompatibilityResult =
  | { ok: true }
  | { ok: false; reason: 'board_name' | 'layout' | 'holds_out_of_range' };

// Cache valid hold ID sets per BoardCompatibilityTarget object so repeated queue-add
// validation doesn't rebuild the Set on every call.
const validHoldIdCache = new WeakMap<BoardCompatibilityTarget, Set<number>>();

function getValidHoldIds(target: BoardCompatibilityTarget): Set<number> | null {
  // If the target board is missing holdsData (which can happen in tests or
  // when a board is stubbed without render data), we can't run the hold-ID
  // containment check. Callers treat a null set as "no per-hold check".
  if (!target.holdsData || !Array.isArray(target.holdsData) || target.holdsData.length === 0) {
    return null;
  }
  const cached = validHoldIdCache.get(target);
  if (cached) return cached;
  const set = new Set<number>();
  for (const hold of target.holdsData) {
    set.add(hold.id);
  }
  validHoldIdCache.set(target, set);
  return set;
}

/**
 * Determine whether a climb can be added to a queue bound to `target`.
 *
 * Rules:
 *  1. `climb.boardType` must match `target.board_name` when set.
 *  2. `climb.layoutId` must match `target.layout_id` when set.
 *  3. Every hold ID referenced in `climb.frames` must exist on the target
 *     board. This naturally allows smaller boards to be added to larger
 *     queues (subset of holds) but rejects larger-board climbs that use
 *     holds missing on a smaller board.
 */
export function canAddClimbToBoard(
  climb: ClimbCompatibilityInput,
  target: BoardCompatibilityTarget,
): BoardCompatibilityResult {
  if (climb.boardType && climb.boardType !== target.board_name) {
    return { ok: false, reason: 'board_name' };
  }
  if (climb.layoutId != null && climb.layoutId !== target.layout_id) {
    return { ok: false, reason: 'layout' };
  }
  const validIds = getValidHoldIds(target);
  if (!validIds) {
    // Target has no usable hold render data — accept the climb rather
    // than blocking it. Layout/board_name already covers the common
    // case, and the WASM renderer will ignore unknown hold IDs at draw
    // time if something slips through.
    return { ok: true };
  }
  const climbHoldIds = parseClimbFrameHoldIds(climb.frames);
  for (const id of climbHoldIds) {
    if (!validIds.has(id)) {
      return { ok: false, reason: 'holds_out_of_range' };
    }
  }
  return { ok: true };
}

export type ClimbBoardCompatibility = 'compatible' | 'incompatible' | 'unknown';

/** The active-board fields needed to judge whether a climb belongs to this board. */
export type ActiveBoardForCompatibility = {
  boardName: BoardName;
  layoutId: number;
};

/** The climb fields that carry board identity. Both are optional in most fetch paths. */
export type ClimbBoardIdentity = {
  boardType?: string | null;
  layoutId?: number | null;
};

/**
 * Decide whether a queued climb can be lit on the connected board.
 *
 * - `unknown` — the climb carries no board metadata (older items, or party-synced
 *   items from before the metadata round-trip). Never block on this; send as today.
 * - `incompatible` — a KNOWN `boardType` or `layoutId` clearly differs from the
 *   active board. A "spill" climb (party peer on another board, or a queue left
 *   over from a board switch) — skip it instead of dark-firing the wall.
 * - `compatible` — the known metadata matches the active board.
 *
 * An unrecognised `boardType` string is treated as no board signal (we can't
 * judge it), falling through to the layout check. Identity only — hold-ID
 * containment stays in `canAddClimbToBoard` so same-layout different-size
 * climbs keep their partial-light behaviour at send time.
 */
export function classifyClimbBoardCompatibility(
  activeConfig: ActiveBoardForCompatibility | undefined,
  climb: ClimbBoardIdentity,
): ClimbBoardCompatibility {
  if (!activeConfig) return 'unknown';
  const climbBoardName = climb.boardType ? toBoardName(climb.boardType) : undefined;
  const hasLayoutSignal = climb.layoutId != null;
  if (climbBoardName == null && !hasLayoutSignal) return 'unknown';
  if (climbBoardName != null && climbBoardName !== activeConfig.boardName) return 'incompatible';
  if (hasLayoutSignal && climb.layoutId !== activeConfig.layoutId) return 'incompatible';
  return 'compatible';
}

/**
 * Scan the queue forward from the current item for the first climb that isn't
 * `incompatible` with the active board, returning it plus how many incompatible
 * climbs were skipped to reach it (the current item counts as skipped when it is
 * itself incompatible). Returns `{ item: null }` when every remaining climb is
 * incompatible. When `activeConfig` is unknown, nothing is incompatible, so the
 * current item is returned with `skippedCount: 0`.
 */
export function findNextCompatibleQueueItem<TItem extends { uuid: string; climb: ClimbBoardIdentity }>(
  queue: ReadonlyArray<TItem>,
  currentUuid: string | null,
  activeConfig: ActiveBoardForCompatibility | undefined,
): { item: TItem | null; skippedCount: number } {
  const foundIndex = currentUuid ? queue.findIndex((entry) => entry.uuid === currentUuid) : -1;
  const startIndex = foundIndex >= 0 ? foundIndex : 0;
  let skippedCount = 0;
  for (let index = startIndex; index < queue.length; index++) {
    const item = queue[index];
    if (classifyClimbBoardCompatibility(activeConfig, item.climb) === 'incompatible') {
      skippedCount++;
      continue;
    }
    return { item, skippedCount };
  }
  return { item: null, skippedCount };
}
