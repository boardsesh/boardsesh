import { describe, expect, it } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import { boardCardAction, sortViewerOwnedFirst, type BoardCardAction } from '../board-card-actions';

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

describe('boardCardAction', () => {
  it('offers a pencil on your own board and Following on one you follow', () => {
    expect(boardCardAction({ isViewerOwner: true, isEditing: false })).toBe('edit');
    expect(boardCardAction({ isViewerOwner: false, isEditing: false })).toBe('unfollow');
  });

  it('turns the slot destructive in edit mode', () => {
    expect(boardCardAction({ isViewerOwner: true, isEditing: true })).toBe('delete');
  });

  // Delete is owner-only server-side, so a followed board must never reach a
  // mutation the backend is going to reject.
  it('never offers delete on a board the viewer does not own, even in edit mode', () => {
    expect(boardCardAction({ isViewerOwner: false, isEditing: true })).toBe('unfollow');
  });

  // Inside `myBoards` every non-owned board is one you already follow, so a
  // "Follow" resting state is unreachable. The real work here is the suppression
  // below: it fails the typecheck if anyone widens the union. The runtime half
  // proves the helper never invents a fourth value — and never returns null,
  // since suppressing the slot entirely is the caller's job, not this helper's.
  it('only ever returns a member of the three-value union', () => {
    // @ts-expect-error — 'follow' is deliberately not part of BoardCardAction.
    const rejected: BoardCardAction = 'follow';
    expect(rejected).toBe('follow');

    const produced = new Set<BoardCardAction>();
    for (const isViewerOwner of [true, false]) {
      for (const isEditing of [true, false]) {
        produced.add(boardCardAction({ isViewerOwner, isEditing }));
      }
    }
    expect([...produced].sort()).toEqual(['delete', 'edit', 'unfollow']);
  });
});

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
