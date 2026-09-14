import type { BoardName } from '@boardsesh/shared-schema';

import { toBoardName } from './board-name';
import { requiredSetIdsForMoonBoard } from './moonboard-cell-sets';
import { parseSetIds } from './set-ids';
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
  | { ok: false; reason: 'board_name' | 'layout' | 'holds_out_of_range' | 'size' };

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
 *  4. On MoonBoard only, and only when the caller supplies `target.set_ids`:
 *     the sets the climb's cells belong to must all be installed on the wall.
 *     MoonBoard's `holdsData` is the whole grid whatever sets are bolted on, so
 *     rule 3 can't catch a wooden-set climb on a base-only wall — the cell-to-set
 *     map can. Aurora boards need no equivalent because their hold placements are
 *     per-set, so an uninstalled set's holds already fail rule 3.
 *  5. Size containment: when the caller knows BOTH the wall's `target.size_id`
 *     and the climb's `compatibleSizeIds`, the wall's size has to be one of
 *     them. This is what separates two sizes whose hold ids overlap without
 *     meaning the same holds — Woods numbers the 8x10's holds 0-484 and the
 *     12x12's 0-893 from its own origin, so every 8x10 climb passes rule 3 on a
 *     12x12 and would silently light a different set of holds. Aurora and
 *     MoonBoard callers that pass neither field keep their previous answer.
 *
 * Rule 5 runs first among the hold checks: it is O(1) and its `'size'` reason is
 * more specific than the `'holds_out_of_range'` rule 3 would report.
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
  if (target.size_id != null && climb.compatibleSizeIds != null && !climb.compatibleSizeIds.includes(target.size_id)) {
    return { ok: false, reason: 'size' };
  }
  if (target.board_name === 'moonboard' && target.set_ids && target.set_ids.length > 0) {
    const installedSetIds = new Set(target.set_ids);
    const requiredSetIds = requiredSetIdsForMoonBoard(target.layout_id, climb.frames ?? '');
    for (const setId of requiredSetIds) {
      if (!installedSetIds.has(setId)) {
        return { ok: false, reason: 'holds_out_of_range' };
      }
    }
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

/**
 * The active-board fields needed to judge whether a climb belongs to this board.
 *
 * `boardName` + `layoutId` are the board MODEL, which every caller knows.
 * `sizeId` and `setIds` describe the PHYSICAL wall, and only the callers that
 * know the connected wall pass them: the BLE auto-sender does, while the queue
 * add gate and the swipe navigator deliberately don't — a same-layout
 * different-size climb still renders on its own board there, so neither should
 * act on it.
 */
export type ActiveBoardForCompatibility = {
  boardName: BoardName;
  layoutId: number;
  /** The product size bolted on the wall. Omit it and the size check is skipped. */
  sizeId?: number;
  /**
   * The hold sets bolted on the wall, either already parsed or in the
   * comma-separated form the board config carries end to end (`'1,20'`). Omit it
   * and the set check is skipped.
   */
  setIds?: readonly number[] | string | null;
};

/** The climb fields that carry board identity. All optional in most fetch paths. */
export type ClimbBoardIdentity = {
  boardType?: string | null;
  layoutId?: number | null;
  /**
   * `board_climbs.compatible_size_ids` — every product size the climb's bounding
   * box fits inside. Null/undefined (legacy row, or a fetch path that doesn't
   * project it) and `[]` (what a `?? []` fetch path emits) both read as "no size
   * signal" and constrain nothing.
   */
  compatibleSizeIds?: readonly number[] | null;
  /** Read only to derive the hold sets a MoonBoard climb needs. */
  frames?: string | null;
};

/** The sets bolted on the wall, normalised, or null when the caller named none. */
function installedWallSetIds(activeConfig: ActiveBoardForCompatibility): number[] | null {
  const { setIds } = activeConfig;
  if (setIds == null) return null;
  const parsedSetIds = typeof setIds === 'string' ? parseSetIds(setIds) : [...setIds];
  return parsedSetIds.length > 0 ? parsedSetIds : null;
}

/**
 * Whether the connected wall's size is one the climb was measured to fit. Both
 * halves have to be known — a wall that names no size, or a climb with no
 * measured sizes, leaves the verdict to the other checks.
 */
function climbFitsWallSize(activeConfig: ActiveBoardForCompatibility, climb: ClimbBoardIdentity): boolean {
  if (activeConfig.sizeId == null) return true;
  if (!climb.compatibleSizeIds?.length) return true;
  return climb.compatibleSizeIds.includes(activeConfig.sizeId);
}

/**
 * Whether every hold set a MoonBoard climb needs is bolted on the connected
 * wall. MoonBoard only, for the same reason as `canAddClimbToBoard` rule 4:
 * Aurora placements are per-set, so an uninstalled set's holds are absent from
 * the wall's placement map and hold-id containment catches them at send time — a
 * check that needs render data this identity-only classifier doesn't have.
 * MoonBoard's grid is the full grid whatever is bolted on, so the cell-to-set
 * map is the only signal, and it needs nothing but the frames.
 */
function climbFitsWallSets(activeConfig: ActiveBoardForCompatibility, climb: ClimbBoardIdentity): boolean {
  if (activeConfig.boardName !== 'moonboard') return true;
  if (!climb.frames) return true;
  const wallSetIds = installedWallSetIds(activeConfig);
  if (!wallSetIds) return true;
  const installedSetIds = new Set(wallSetIds);
  return requiredSetIdsForMoonBoard(activeConfig.layoutId, climb.frames).every((setId) => installedSetIds.has(setId));
}

/**
 * Decide whether a queued climb can be lit on the connected board.
 *
 * - `unknown` — the climb carries no board metadata (older items, or party-synced
 *   items from before the metadata round-trip). Never block on this; send as today.
 * - `incompatible` — a KNOWN climb field clearly differs from the active board:
 *   its `boardType`, its `layoutId`, the wall's size, or a MoonBoard hold set the
 *   wall doesn't have. A "spill" climb (party peer on another board, a queue left
 *   over from a board switch, or a climb set on a bigger wall) — skip it instead
 *   of writing a partial climb the wall cannot show.
 * - `compatible` — the known metadata matches the active board.
 *
 * Every check is opt-in from BOTH sides: a caller that names no wall size/sets,
 * or a climb carrying none, keeps exactly the verdict it had before those checks
 * existed. That asymmetry is the point — missing metadata must never become
 * `incompatible`, or a queue starts skipping climbs that light fine today.
 *
 * Size was checked for Woods alone until #5109, on the grounds that its two
 * boards number their holds from their own origins. The same failure is just
 * quieter elsewhere: a Kilter Original 12x14 climb on a connected 12x12 has
 * placements the smaller wall doesn't have, so the wall lights the part it can
 * and buzzes success — a complete-looking climb that is the wrong climb. The
 * check is general now; only the callers that know the physical wall feel it.
 *
 * An unrecognised `boardType` string is treated as no board signal (we can't
 * judge it), falling through to the layout check.
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
  if (!climbFitsWallSize(activeConfig, climb)) return 'incompatible';
  if (!climbFitsWallSets(activeConfig, climb)) return 'incompatible';
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
