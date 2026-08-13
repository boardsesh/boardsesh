/**
 * Encoding for the entries of the `syncEnabledBoards` setting. Each entry is one
 * board a user made available offline, scoped to a single (boardType, layout,
 * size) — always all sets. The encoded form `"boardType:layoutId:sizeId"` is what
 * the pull client parses to scope syncClimbs/syncClimbStats, and what the per-board
 * download checkpoints key on.
 *
 * Pure module (no React, no MMKV) so the pull client can import `parseOfflineBoardKey`
 * without dragging the settings store or React into its dependency graph.
 */

export type OfflineBoardScope = {
  boardType: string;
  layoutId: number;
  sizeId: number;
};

/** The minimal board shape needed to derive an offline scope (a UserBoard fits). */
export type OfflineBoardLike = {
  boardType: string;
  layoutId: number;
  sizeId: number;
};

export function offlineBoardScopeForBoard(board: OfflineBoardLike): OfflineBoardScope {
  return { boardType: board.boardType, layoutId: board.layoutId, sizeId: board.sizeId };
}

export function offlineBoardKey(scope: OfflineBoardScope): string {
  return `${scope.boardType}:${scope.layoutId}:${scope.sizeId}`;
}

export function offlineBoardKeyForBoard(board: OfflineBoardLike): string {
  return offlineBoardKey(offlineBoardScopeForBoard(board));
}

/**
 * Parse a stored key back into a scope. Board types never contain ':' and
 * layout/size are integers, so a strict 3-part split is safe. Defensive by design:
 * a malformed or legacy entry (e.g. a bare `"kilter"` from an earlier build)
 * returns null so it's skipped rather than producing NaN scope ids that would
 * poison the pull loop.
 */
export function parseOfflineBoardKey(key: string): OfflineBoardScope | null {
  const parts = key.split(':');
  if (parts.length !== 3) return null;
  const [boardType, layoutRaw, sizeRaw] = parts;
  const layoutId = Number(layoutRaw);
  const sizeId = Number(sizeRaw);
  if (!boardType || !Number.isInteger(layoutId) || !Number.isInteger(sizeId)) return null;
  return { boardType, layoutId, sizeId };
}

/**
 * The purge namespace a board scope belongs to (issue #4370): `boardType:layoutId`.
 *
 * Two independent reasons this is the layout and not the full scope key:
 *
 *  - It is exactly the blast radius of `removeBoardScopeData`'s DELETEs —
 *    `board_type = ? AND layout_id = ?`, plus an optional retained-sizes
 *    negation. A purge provably cannot touch a row or a marker belonging to a
 *    different namespace, without the correctness argument depending on the
 *    compatible_size_ids retention clause holding for every future column.
 *  - `runBootstrapPhase` already caches BOTH snapshot artifacts under this exact
 *    string, because one artifact serves every size of a layout. A finer
 *    namespace would be finer than the one native transfer a purge must cancel.
 *
 * Cost of the coarser key: removing Kilter 12x12 while Kilter 8x12 (same layout)
 * is downloading aborts the sibling for one cycle, which resumes from intact
 * checkpoints on the next trigger.
 */
export function purgeNamespaceKey(scope: Pick<OfflineBoardScope, 'boardType' | 'layoutId'>): string {
  return `${scope.boardType}:${scope.layoutId}`;
}

/**
 * The namespace for a stored scope key, or `undefined` when the key is
 * malformed. Callers must then treat the work as global-only — a key we cannot
 * parse must never be laundered as a scope purge, because we cannot prove which
 * namespace it is in.
 */
export function purgeNamespaceForScopeKey(scopeKey: string): string | undefined {
  const parsed = parseOfflineBoardKey(scopeKey);
  return parsed ? purgeNamespaceKey(parsed) : undefined;
}
