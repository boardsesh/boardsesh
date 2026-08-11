/**
 * Cross-board queue decisions: should adding this climb raise a "that's a
 * different board" prompt, or just go in?
 *
 * A queue is allowed to hold climbs from more than one board — the BLE senders
 * already skip an item that doesn't match the connected wall instead of
 * dark-firing it (`classifyClimbBoardCompatibility` /
 * `findNextCompatibleQueueItem` in `@boardsesh/board-config`). What was missing
 * is the deliberate act: the climber says "yes, queue it anyway" (or "switch me
 * to that board") instead of a foreign climb landing silently.
 *
 * Two deliberate design choices:
 *
 * 1. **The compatibility classifier is injected.** This package has
 *    `dependencies: {}` on purpose (the backend imports it), so it must not
 *    grow a `@boardsesh/board-config` edge. Callers pass
 *    `classifyClimbBoardCompatibility` in, the same way `createPlaylistSuggestionSource`
 *    takes an injected `isClimbable`.
 * 2. **"Add anyway" is remembered by queue contents, not by extra state.**
 *    `deriveAcceptedConfigs` reads the boards already represented in the live
 *    queue, so the second climb from a board you just accepted never re-prompts.
 *    Remove the last climb from that board and the next add prompts again —
 *    that is the trade for having no acceptance flag that can go stale against
 *    a party-synced queue.
 *
 * `configKey` is board MODEL identity (board name + layout) only. A `Climb`
 * carries no size, so a same-layout/different-size mismatch can't be seen from
 * queue metadata at all; `canAddClimbToBoard`'s hold-ID containment already
 * catches that at send time.
 */

/** The active board's model identity — what a queue is "on". */
export type QueueBoardIdentity = {
  boardName: string;
  layoutId: number;
};

/** The climb fields carrying board identity. Both are optional on most fetch paths. */
export type ClimbBoardIdentityLike = {
  boardType?: string | null;
  layoutId?: number | null;
};

/** Mirrors `ClimbBoardCompatibility` in `@boardsesh/board-config` (injected, not imported). */
export type ClimbBoardCompatibility = 'compatible' | 'incompatible' | 'unknown';

/** Stable string identity for a board model. Board name + layout, nothing else. */
export function configKey(config: QueueBoardIdentity): string {
  return `${config.boardName}:${config.layoutId}`;
}

/**
 * The board-model key a climb belongs to, or `null` when it carries no usable
 * board signal. Both halves are required: a climb with a board name but no
 * layout can't be pinned to a board model, and treating it as its own key would
 * let a half-known climb silently widen the accepted set.
 */
export function climbConfigKey(climb: ClimbBoardIdentityLike): string | null {
  if (!climb.boardType || climb.layoutId == null) return null;
  return configKey({ boardName: climb.boardType, layoutId: climb.layoutId });
}

/**
 * Every board model the queue is already known to hold, plus the active board.
 * A climb whose key is in here has been accepted into this queue once already,
 * so adding another of its siblings needs no second prompt.
 */
export function deriveAcceptedConfigs(
  queue: ReadonlyArray<{ climb: ClimbBoardIdentityLike }>,
  activeConfig?: QueueBoardIdentity,
): ReadonlySet<string> {
  const accepted = new Set<string>();
  if (activeConfig) accepted.add(configKey(activeConfig));
  for (const item of queue) {
    const key = climbConfigKey(item.climb);
    if (key) accepted.add(key);
  }
  return accepted;
}

/** Add it now, and why — `already-mixed` means this board is already in the queue. */
export type AddDecision =
  | { kind: 'add'; reason: 'compatible' | 'unknown' | 'already-mixed' }
  | { kind: 'confirm'; climbConfigKey: string; climbBoardName: string; climbLayoutId: number };

export type DecideAddInput<TBoard extends QueueBoardIdentity> = {
  climb: ClimbBoardIdentityLike;
  /** The board the queue is on. `undefined` when the climber hasn't picked one. */
  activeConfig: TBoard | undefined;
  /** From `deriveAcceptedConfigs`. */
  acceptedConfigKeys: ReadonlySet<string>;
  /** Injected — pass `classifyClimbBoardCompatibility` from `@boardsesh/board-config`. */
  classify: (activeConfig: TBoard | undefined, climb: ClimbBoardIdentityLike) => ClimbBoardCompatibility;
};

/**
 * Decide whether an add needs the cross-board prompt.
 *
 * - `compatible` / `unknown` → add, no prompt. Never block on missing metadata:
 *   older queue items and party-synced climbs legitimately have none.
 * - `incompatible` but the climb's board is already in the queue → add, no
 *   prompt (the climber already said yes to this board).
 * - `incompatible` and unrecognised board metadata (no `climbConfigKey`) → add.
 *   We'd have nothing to name in the prompt or remember afterwards.
 * - otherwise → confirm.
 *
 * `TBoard` is generic so a caller whose active board is typed with the narrower
 * `BoardName` union can still hand in `classifyClimbBoardCompatibility` under
 * `strictFunctionTypes` parameter contravariance.
 */
export function decideAdd<TBoard extends QueueBoardIdentity>({
  climb,
  activeConfig,
  acceptedConfigKeys,
  classify,
}: DecideAddInput<TBoard>): AddDecision {
  const compatibility = classify(activeConfig, climb);
  if (compatibility === 'compatible') return { kind: 'add', reason: 'compatible' };
  if (compatibility === 'unknown') return { kind: 'add', reason: 'unknown' };

  const climbBoardName = climb.boardType;
  const climbLayoutId = climb.layoutId;
  if (!climbBoardName || climbLayoutId == null) return { kind: 'add', reason: 'unknown' };

  const key = configKey({ boardName: climbBoardName, layoutId: climbLayoutId });
  if (acceptedConfigKeys.has(key)) return { kind: 'add', reason: 'already-mixed' };

  return { kind: 'confirm', climbConfigKey: key, climbBoardName, climbLayoutId };
}
