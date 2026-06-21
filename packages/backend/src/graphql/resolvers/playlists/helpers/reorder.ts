/** A playlist climb row as far as reordering cares: its id and current position. */
export type ReorderRow<Id> = {
  id: Id;
  climbUuid: string;
  position: number;
};

/** The minimal set of rows to rewrite, with their new dense positions. */
export type ReorderWrite<Id> = {
  id: Id;
  position: number;
};

/**
 * Compute the position writes for moving `climbUuid` to `newIndex` within an
 * already-ordered list (`rows` must be sorted by current position).
 *
 * The result renumbers the list to a dense `0..n-1` but returns ONLY the rows
 * whose position actually changes — so the caller can persist them in a single
 * batched statement. Deriving the move from ranks (not raw position values)
 * makes it robust to the position gaps that deletions leave behind.
 *
 * Throws if `climbUuid` isn't in the list.
 */
export function computePlaylistReorderWrites<Id>(
  rows: ReadonlyArray<ReorderRow<Id>>,
  climbUuid: string,
  newIndex: number,
): ReorderWrite<Id>[] {
  const oldIndex = rows.findIndex((row) => row.climbUuid === climbUuid);
  if (oldIndex === -1) {
    throw new Error('Climb not found in playlist');
  }

  // Clamp the target into range; a true no-op move yields an empty write set —
  // short-circuit so a misbehaving client sending the current index can't make
  // us renumber (and rewrite) a gappy list for no reason.
  const targetIndex = Math.min(Math.max(newIndex, 0), rows.length - 1);
  if (targetIndex === oldIndex) {
    return [];
  }

  const reordered = [...rows];
  const [moved] = reordered.splice(oldIndex, 1);
  reordered.splice(targetIndex, 0, moved);

  const writes: ReorderWrite<Id>[] = [];
  for (let index = 0; index < reordered.length; index++) {
    if (reordered[index].position !== index) {
      writes.push({ id: reordered[index].id, position: index });
    }
  }
  return writes;
}
