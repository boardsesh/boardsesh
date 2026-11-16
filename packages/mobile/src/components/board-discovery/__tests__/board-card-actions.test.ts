import { describe, expect, it } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import { sortViewerOwnedFirst, hoistActiveBoard } from '../board-card-actions';

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

describe('hoistActiveBoard', () => {
  const mine = board({ uuid: 'mine', ownerId: 'me' });
  const gym = board({ uuid: 'gym', ownerId: 'someone-else' });
  const otherGym = board({ uuid: 'other-gym', ownerId: 'someone-else' });

  it('moves the active board to the front, keeping everything else in order', () => {
    const hoisted = hoistActiveBoard([gym, mine, otherGym], 'mine');
    expect(hoisted.map((entry) => entry.uuid)).toEqual(['mine', 'gym', 'other-gym']);
  });

  it('leaves the order alone when the active board already leads', () => {
    const hoisted = hoistActiveBoard([mine, gym], 'mine');
    expect(hoisted.map((entry) => entry.uuid)).toEqual(['mine', 'gym']);
  });

  it('leaves the order alone with no active board', () => {
    expect(hoistActiveBoard([gym, mine], undefined).map((entry) => entry.uuid)).toEqual(['gym', 'mine']);
    expect(hoistActiveBoard([gym, mine], null).map((entry) => entry.uuid)).toEqual(['gym', 'mine']);
  });

  // Hoist-only: a stored board the server no longer lists must not conjure a card.
  it('injects nothing when the active board is not in the list', () => {
    const hoisted = hoistActiveBoard([gym, mine], 'deleted-board');
    expect(hoisted.map((entry) => entry.uuid)).toEqual(['gym', 'mine']);
  });

  it('never duplicates the active board', () => {
    const hoisted = hoistActiveBoard([gym, mine, otherGym], 'gym');
    expect(hoisted.filter((entry) => entry.uuid === 'gym')).toHaveLength(1);
    expect(hoisted).toHaveLength(3);
  });
});
