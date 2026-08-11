import { describe, it, expect } from 'vite-plus/test';
import { computePlaylistReorderWrites, type ReorderRow } from '../graphql/resolvers/playlists/helpers/reorder';

/** Dense list A,B,C,D,E at positions 0..4. */
function denseRows(): ReorderRow<number>[] {
  return [
    { id: 1, climbUuid: 'a', position: 0 },
    { id: 2, climbUuid: 'b', position: 1 },
    { id: 3, climbUuid: 'c', position: 2 },
    { id: 4, climbUuid: 'd', position: 3 },
    { id: 5, climbUuid: 'e', position: 4 },
  ];
}

describe('computePlaylistReorderWrites', () => {
  it('moves a climb to the front and renumbers densely', () => {
    // [A,B,C,D,E] → move E (index 4) to 0 → [E,A,B,C,D].
    const writes = computePlaylistReorderWrites(denseRows(), 'e', 0);
    expect(writes).toEqual([
      { id: 5, position: 0 },
      { id: 1, position: 1 },
      { id: 2, position: 2 },
      { id: 3, position: 3 },
      { id: 4, position: 4 },
    ]);
  });

  it('writes only the rows that actually shift for an interior move', () => {
    // Move D (index 3) up to index 2 → [A,B,D,C,E]. Only D and C shift.
    const writes = computePlaylistReorderWrites(denseRows(), 'd', 2);
    expect(writes).toEqual([
      { id: 4, position: 2 },
      { id: 3, position: 3 },
    ]);
  });

  it('clamps an out-of-range index to the last position', () => {
    // Move A (index 0) to 99 → clamp to 4 → [B,C,D,E,A]; every row shifts.
    const writes = computePlaylistReorderWrites(denseRows(), 'a', 99);
    expect(writes).toEqual([
      { id: 2, position: 0 },
      { id: 3, position: 1 },
      { id: 4, position: 2 },
      { id: 5, position: 3 },
      { id: 1, position: 4 },
    ]);
  });

  it('returns no writes for a no-op move', () => {
    expect(computePlaylistReorderWrites(denseRows(), 'a', 0)).toEqual([]);
  });

  it('returns no writes for a no-op move even on a gappy list (no needless compaction)', () => {
    const gappy: ReorderRow<number>[] = [
      { id: 1, climbUuid: 'a', position: 0 },
      { id: 2, climbUuid: 'b', position: 5 },
      { id: 3, climbUuid: 'c', position: 10 },
    ];
    // Ask to move 'b' to its own rank (1) — a true no-op must not renumber the
    // gaps away.
    expect(computePlaylistReorderWrites(gappy, 'b', 1)).toEqual([]);
  });

  it('handles gappy positions (left by deletions) by renumbering to dense', () => {
    // Positions 0,5,10 (gaps) — move the last (rank 2) to the front.
    const gappy: ReorderRow<number>[] = [
      { id: 1, climbUuid: 'a', position: 0 },
      { id: 2, climbUuid: 'b', position: 5 },
      { id: 3, climbUuid: 'c', position: 10 },
    ];
    const writes = computePlaylistReorderWrites(gappy, 'c', 0);
    expect(writes).toEqual([
      { id: 3, position: 0 },
      { id: 1, position: 1 },
      { id: 2, position: 2 },
    ]);
  });

  it('throws when the climb is not in the playlist', () => {
    expect(() => computePlaylistReorderWrites(denseRows(), 'missing', 0)).toThrow('Climb not found in playlist');
  });
});

// #4012: the client computes `newIndex` against the list it renders, and that
// list comes from an inner join to board_climbs — a playlist row whose climb no
// longer resolves is invisible there but still holds a position in the full
// list. `x`/`y` below are those invisible rows.
describe('computePlaylistReorderWrites — visible-index translation', () => {
  it('resolves the target index against the visible rows when an orphan sits ahead', () => {
    // Full [X,A,B,C]; the user sees [A,B,C] and drags A to the end (visible 2).
    // Full-list semantics would land A at full index 2 → visible [B,A,C].
    const rows: ReorderRow<number>[] = [
      { id: 9, climbUuid: 'x', position: 0 },
      { id: 1, climbUuid: 'a', position: 1 },
      { id: 2, climbUuid: 'b', position: 2 },
      { id: 3, climbUuid: 'c', position: 3 },
    ];
    const writes = computePlaylistReorderWrites(rows, 'a', 2, new Set(['a', 'b', 'c']));
    // → [X,B,C,A]: visible [B,C,A], exactly what the user dropped.
    expect(writes).toEqual([
      { id: 2, position: 1 },
      { id: 3, position: 2 },
      { id: 1, position: 3 },
    ]);
  });

  it('leaves an orphan below the move untouched', () => {
    // Full [A,B,C,X]; move C to the front. Nothing crosses X, so it keeps its
    // position and stays out of the write set.
    const rows: ReorderRow<number>[] = [
      { id: 1, climbUuid: 'a', position: 0 },
      { id: 2, climbUuid: 'b', position: 1 },
      { id: 3, climbUuid: 'c', position: 2 },
      { id: 9, climbUuid: 'x', position: 3 },
    ];
    const writes = computePlaylistReorderWrites(rows, 'c', 0, new Set(['a', 'b', 'c']));
    expect(writes).toEqual([
      { id: 3, position: 0 },
      { id: 1, position: 1 },
      { id: 2, position: 2 },
    ]);
  });

  it('keeps a trailing orphan at the tail when moving to the visible end', () => {
    // Full [A,B,X]; visible [A,B]. Move A to visible index 1 → [B,A,X].
    const rows: ReorderRow<number>[] = [
      { id: 1, climbUuid: 'a', position: 0 },
      { id: 2, climbUuid: 'b', position: 1 },
      { id: 9, climbUuid: 'x', position: 2 },
    ];
    const writes = computePlaylistReorderWrites(rows, 'a', 1, new Set(['a', 'b']));
    expect(writes).toEqual([
      { id: 2, position: 0 },
      { id: 1, position: 1 },
    ]);
  });

  it('clamps to the last VISIBLE index, not the last row', () => {
    // Same list; an out-of-range index clamps to visible index 1, so A lands
    // ahead of the orphan rather than after it.
    const rows: ReorderRow<number>[] = [
      { id: 1, climbUuid: 'a', position: 0 },
      { id: 2, climbUuid: 'b', position: 1 },
      { id: 9, climbUuid: 'x', position: 2 },
    ];
    expect(computePlaylistReorderWrites(rows, 'a', 99, new Set(['a', 'b']))).toEqual([
      { id: 2, position: 0 },
      { id: 1, position: 1 },
    ]);
  });

  it('renumbers a gappy list with an orphan into dense visible order', () => {
    const rows: ReorderRow<number>[] = [
      { id: 9, climbUuid: 'x', position: 0 },
      { id: 1, climbUuid: 'a', position: 5 },
      { id: 2, climbUuid: 'b', position: 10 },
      { id: 3, climbUuid: 'c', position: 20 },
    ];
    // Visible [A,B,C]; move C between A and B → full [X,A,C,B].
    expect(computePlaylistReorderWrites(rows, 'c', 1, new Set(['a', 'b', 'c']))).toEqual([
      { id: 1, position: 1 },
      { id: 3, position: 2 },
      { id: 2, position: 3 },
    ]);
  });

  it('treats a move to the same visible index as a no-op, orphan and all', () => {
    // A is already first on screen; there is no reason to hoist it past X.
    const rows: ReorderRow<number>[] = [
      { id: 9, climbUuid: 'x', position: 0 },
      { id: 1, climbUuid: 'a', position: 1 },
      { id: 2, climbUuid: 'b', position: 2 },
    ];
    expect(computePlaylistReorderWrites(rows, 'a', 0, new Set(['a', 'b']))).toEqual([]);
  });

  it('is a no-op when the moved row is the only visible one', () => {
    const rows: ReorderRow<number>[] = [
      { id: 9, climbUuid: 'x', position: 0 },
      { id: 1, climbUuid: 'a', position: 1 },
      { id: 8, climbUuid: 'y', position: 2 },
    ];
    expect(computePlaylistReorderWrites(rows, 'a', 2, new Set(['a']))).toEqual([]);
  });

  it('matches full-list behaviour when every row resolves', () => {
    const allVisible = new Set(['a', 'b', 'c', 'd', 'e']);
    for (const [climbUuid, newIndex] of [
      ['e', 0],
      ['d', 2],
      ['a', 99],
      ['a', 0],
      ['c', 4],
    ] as const) {
      expect(computePlaylistReorderWrites(denseRows(), climbUuid, newIndex, allVisible)).toEqual(
        computePlaylistReorderWrites(denseRows(), climbUuid, newIndex),
      );
    }
  });

  it('falls back to full-list semantics when the moved row itself is invisible', () => {
    // Can't come from the UI (the row isn't rendered), so there is no visible
    // index to honour — behave exactly as before.
    const writes = computePlaylistReorderWrites(denseRows(), 'e', 0, new Set(['a', 'b', 'c', 'd']));
    expect(writes).toEqual(computePlaylistReorderWrites(denseRows(), 'e', 0));
  });
});
