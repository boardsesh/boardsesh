type LooseBoard = { boardName: string; layoutId?: number | null } | null | undefined;

/**
 * Loose board identity: the same board model (board name + layout). Size, sets,
 * and angle may legitimately differ between a playlist/tick's resolved render
 * config (largest size + all sets) and the user's precise active board, so they
 * are intentionally NOT compared. A null/undefined `layoutId` on either side
 * means "unspecified" and never causes a rejection — matching the original
 * inline predicate in `usePlaylistRenderBoard`.
 */
export function boardLooselyMatches(left: LooseBoard, right: LooseBoard): boolean {
  if (!left || !right) return false;
  if (left.boardName !== right.boardName) return false;
  if (left.layoutId == null || right.layoutId == null) return true;
  return left.layoutId === right.layoutId;
}
