// The popular-config list IS the www homepage board rail and the mobile Boards
// tab, so a row in it is a board offered to every visitor. A spray wall is one
// climber's own wall and must never appear there — not even if SW-04 mis-seeds a
// listed catalogue row for one.
//
// Two layers guard it and both are deliberate: the SQL drops spray before the
// expensive per-config LATERAL climb count is built, and `isPopularConfigRow`
// drops it again on the way out. This file pins the second; the SQL predicate is
// NOT covered by any test (the only other popular-configs suite mocks `db.execute`)
// and is a cost optimisation on top of `isPopularConfigRow`, not the privacy guard.
// Also pinned: the two display names spray needed so a wall is never called
// "spray Board".

import { describe, it, expect } from 'vite-plus/test';
import { boardTypeLabel, CATALOGUE_BOARD_TYPES } from '@boardsesh/board-constants';
import { isPopularConfigRow } from '../graphql/resolvers/social/boards';
import { defaultBoardName } from '../graphql/resolvers/board-presence/shared';

describe('isPopularConfigRow', () => {
  it('drops a spray row', () => {
    expect(isPopularConfigRow({ board_type: 'spray' })).toBe(false);
  });

  it('keeps every catalogue board', () => {
    for (const boardType of CATALOGUE_BOARD_TYPES) {
      expect(isPopularConfigRow({ board_type: boardType }), boardType).toBe(true);
    }
  });

  it('keeps a board type it has never heard of', () => {
    // Fail OPEN for an unknown type: this is a privacy exclusion for one named
    // board, not an allow list, and a board added tomorrow must reach the rail
    // without editing this set.
    expect(isPopularConfigRow({ board_type: 'somenewboard' })).toBe(true);
  });
});

describe('spray display names', () => {
  it('calls a spray wall "Spray wall", not "Spray"', () => {
    expect(boardTypeLabel('spray')).toBe('Spray wall');
  });

  it('never names a board "spray Board" or "Spray wall Board"', () => {
    expect(defaultBoardName('spray')).toBe('Spray wall');
    // The generic rule is unchanged for every catalogue board.
    expect(defaultBoardName('kilter')).toBe('Kilter Board');
  });
});
