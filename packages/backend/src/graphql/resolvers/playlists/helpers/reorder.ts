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
 * `newIndex` is an index into the list the CLIENT renders, which is not always
 * the full `playlist_climbs` list: the playlistClimbs query inner-joins
 * `board_climbs`, so a row whose `climb_uuid` no longer resolves (catalog sync
 * lag, a climb that left the catalog) is invisible to the user while still
 * occupying a position here. `resolvableClimbUuids` names the rows the client
 * can see; the target index is resolved against that sublist and translated
 * back into the full list, so one invisible row no longer shifts every move
 * below it by one (#4012). Omit it — or pass a set covering every row — and the
 * whole list counts as visible, which is the plain full-list behaviour.
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
  resolvableClimbUuids?: ReadonlySet<string>,
): ReorderWrite<Id>[] {
  const oldIndex = rows.findIndex((row) => row.climbUuid === climbUuid);
  if (oldIndex === -1) {
    throw new Error('Climb not found in playlist');
  }

  const isVisible = (row: ReorderRow<Id>): boolean =>
    resolvableClimbUuids === undefined || resolvableClimbUuids.has(row.climbUuid);
  // The moved row itself has to be one the client renders for its index to mean
  // anything in visible space. A move of an invisible row can't come from the UI
  // — it isn't on screen — so fall back to full-list semantics instead of
  // inventing a visible slot for it.
  const inVisibleSpace = isVisible(rows[oldIndex]);
  const visibleRows = inVisibleSpace ? rows.filter(isVisible) : rows;

  // Clamp the target into range; a true no-op move yields an empty write set —
  // short-circuit so a misbehaving client sending the current index can't make
  // us renumber (and rewrite) a gappy list for no reason.
  const oldVisibleIndex = visibleRows.findIndex((row) => row.climbUuid === climbUuid);
  const targetVisibleIndex = Math.min(Math.max(newIndex, 0), visibleRows.length - 1);
  if (targetVisibleIndex === oldVisibleIndex) {
    return [];
  }

  const remaining = rows.filter((_, index) => index !== oldIndex);
  // Where each still-visible row sits in `remaining`, so a visible target index
  // maps to an insertion point in the full list.
  const visibleIndexesInRemaining: number[] = [];
  for (let index = 0; index < remaining.length; index++) {
    if (!inVisibleSpace || isVisible(remaining[index])) {
      visibleIndexesInRemaining.push(index);
    }
  }

  let insertAt: number;
  if (targetVisibleIndex < visibleIndexesInRemaining.length) {
    // Land immediately before the visible row currently holding the target
    // index, so exactly `targetVisibleIndex` visible rows end up ahead.
    insertAt = visibleIndexesInRemaining[targetVisibleIndex];
  } else if (visibleIndexesInRemaining.length > 0) {
    // Moving to the visible end: land just after the last visible row rather
    // than after any trailing invisible rows — same visible result, fewer
    // position writes, and the invisible rows stay put.
    insertAt = visibleIndexesInRemaining[visibleIndexesInRemaining.length - 1] + 1;
  } else {
    insertAt = remaining.length;
  }

  const reordered = [...remaining];
  reordered.splice(insertAt, 0, rows[oldIndex]);

  const writes: ReorderWrite<Id>[] = [];
  for (let index = 0; index < reordered.length; index++) {
    if (reordered[index].position !== index) {
      writes.push({ id: reordered[index].id, position: index });
    }
  }
  return writes;
}
