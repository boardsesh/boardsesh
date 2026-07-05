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
