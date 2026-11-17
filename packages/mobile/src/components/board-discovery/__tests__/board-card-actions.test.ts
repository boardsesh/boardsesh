import { describe, expect, it } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import { sortViewerOwnedFirst, withoutBoardsShown } from '../board-card-actions';

const board = (overrides: Partial<UserBoard> & { uuid: string }): UserBoard =>
  ({
    name: overrides.uuid,
    boardType: 'kilter',
    layoutId: 8,
    sizeId: 17,
    setIds: '20,21',
    angle: 40,
    isOwned: true,
    ...overrides,
  }) as unknown as UserBoard;

// Which actions a card offers moved to board-card-menu.ts, with its table test
// in board-card-menu.test.ts. This file keeps the list ordering.
describe('sortViewerOwnedFirst', () => {
  const mine = board({ uuid: 'mine', ownerId: 'me' });
  const alsoMine = board({ uuid: 'also-mine', ownerId: 'me' });
  const gym = board({ uuid: 'gym', ownerId: 'someone-else' });
  const otherGym = board({ uuid: 'other-gym', ownerId: 'someone-else' });

  it('leads with the viewer’s own boards', () => {
    const sorted = sortViewerOwnedFirst([gym, mine], 'me');
    expect(sorted.map((entry) => entry.uuid)).toEqual(['mine', 'gym']);
  });

  it('keeps the incoming order inside each group', () => {
    const sorted = sortViewerOwnedFirst([gym, mine, otherGym, alsoMine], 'me');
    expect(sorted.map((entry) => entry.uuid)).toEqual(['mine', 'also-mine', 'gym', 'other-gym']);
  });

  // Guessing would file the user's own wall behind boards they follow.
  it('returns the input order unchanged with no identity', () => {
    const sorted = sortViewerOwnedFirst([gym, mine], undefined);
    expect(sorted.map((entry) => entry.uuid)).toEqual(['gym', 'mine']);
  });

  // The offline-snapshot path: a card written by a build that never captured
  // ownerId still carries the server's own isOwned answer.
  it('falls back to the board’s own isOwned flag when it has no ownerId', () => {
    const snapshotMine = board({ uuid: 'snapshot-mine', ownerId: undefined, isOwned: true });
    const snapshotFollowed = board({ uuid: 'snapshot-followed', ownerId: undefined, isOwned: false });
    const sorted = sortViewerOwnedFirst([snapshotFollowed, snapshotMine], 'me');
    expect(sorted.map((entry) => entry.uuid)).toEqual(['snapshot-mine', 'snapshot-followed']);
  });
});

describe('withoutBoardsShown', () => {
  const mine = board({ uuid: 'mine', ownerId: 'me' });
  const gym = board({ uuid: 'gym', ownerId: 'someone-else' });
  const otherGym = board({ uuid: 'other-gym', ownerId: 'someone-else' });

  // The top of the picker lists the board you're on and its gym's walls.
  it('leaves out the boards already shown, keeping the rest in order', () => {
    const rest = withoutBoardsShown([gym, mine, otherGym], new Set(['gym']));
    expect(rest.map((entry) => entry.uuid)).toEqual(['mine', 'other-gym']);
  });

  // No hoist: the board you're on keeps the server's place when nothing above lists it.
  it('keeps the order the server sent when nothing is shown above', () => {
    const rest = withoutBoardsShown([gym, mine, otherGym], new Set());
    expect(rest.map((entry) => entry.uuid)).toEqual(['gym', 'mine', 'other-gym']);
  });

  it('ignores shown boards the list does not hold', () => {
    const rest = withoutBoardsShown([gym, mine], new Set(['deleted-board']));
    expect(rest.map((entry) => entry.uuid)).toEqual(['gym', 'mine']);
  });

  it('returns a copy, never the list it was given', () => {
    const boards = [gym, mine];
    expect(withoutBoardsShown(boards, new Set())).not.toBe(boards);
  });
});
