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
