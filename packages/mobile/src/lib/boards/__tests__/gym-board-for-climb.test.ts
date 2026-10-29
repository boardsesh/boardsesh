import { describe, expect, it } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import { findGymBoardForClimb, findGymBoardToConnectForClimb } from '../gym-board-for-climb';

function makeBoard(overrides: Partial<UserBoard>): UserBoard {
  return {
    uuid: 'board',
    slug: 'board',
    ownerId: 'owner-1',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    name: 'Board',
    isPublic: true,
    isUnlisted: false,
    hideLocation: false,
    isOwned: false,
    angle: 40,
    isAngleAdjustable: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    totalAscents: 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
    canEdit: false,
    ...overrides,
  };
}

// The gym from the 2.7.0 QA run: a Kilter, a MoonBoard and a Tension.
const KILTER = makeBoard({ uuid: 'gym-kilter', boardType: 'kilter', layoutId: 1, name: 'Gym Kilter' });
const MOONBOARD = makeBoard({
  uuid: 'gym-moon',
  boardType: 'moonboard',
  layoutId: 2,
  sizeId: 1,
  name: 'Gym MoonBoard',
});
const TENSION = makeBoard({ uuid: 'gym-tension', boardType: 'tension', layoutId: 9, name: 'Gym Tension' });
const GYM = [KILTER, MOONBOARD, TENSION];

describe('findGymBoardToConnectForClimb (#7001)', () => {
  it('picks the gym MoonBoard for a MoonBoard climb while the Kilter is active', () => {
    expect(findGymBoardToConnectForClimb({ boardType: 'moonboard', layoutId: 2 }, KILTER, GYM)).toBe(MOONBOARD);
  });

  it('picks the gym Tension for a Tension climb while the MoonBoard is active', () => {
    expect(findGymBoardToConnectForClimb({ boardType: 'tension', layoutId: 9 }, MOONBOARD, GYM)).toBe(TENSION);
  });

  it('stays on the active board for a climb it draws', () => {
    expect(findGymBoardToConnectForClimb({ boardType: 'kilter', layoutId: 1 }, KILTER, GYM)).toBeNull();
  });

  it('stays on the active board for a same-model climb, even with a twin board at the gym', () => {
    // A bigger Kilter of the same layout is not a different board model. The
    // player draws it on the active board, so the connect stays there too.
    const twin = makeBoard({ uuid: 'gym-kilter-big', boardType: 'kilter', layoutId: 1, sizeId: 14 });
    expect(findGymBoardToConnectForClimb({ boardType: 'kilter', layoutId: 1 }, KILTER, [...GYM, twin])).toBeNull();
  });

  it('stays on the active board when no board at the gym draws the climb', () => {
    expect(findGymBoardToConnectForClimb({ boardType: 'decoy', layoutId: 1 }, KILTER, GYM)).toBeNull();
    // A home wall has no gym roster at all.
    expect(findGymBoardToConnectForClimb({ boardType: 'moonboard', layoutId: 2 }, KILTER, undefined)).toBeNull();
  });

  it('stays on the active board for a climb with no board name', () => {
    expect(findGymBoardToConnectForClimb({ layoutId: 2 }, KILTER, GYM)).toBeNull();
    expect(findGymBoardToConnectForClimb(null, KILTER, GYM)).toBeNull();
  });

  it('does nothing with no active board', () => {
    expect(findGymBoardToConnectForClimb({ boardType: 'moonboard', layoutId: 2 }, null, GYM)).toBeNull();
  });
});

describe('findGymBoardForClimb', () => {
  it('never returns the active board itself', () => {
    expect(findGymBoardForClimb({ boardName: 'kilter', layoutId: 1 }, KILTER.uuid, GYM)).toBeNull();
  });

  it('matches on board name and layout, ignoring size', () => {
    expect(findGymBoardForClimb({ boardName: 'moonboard', layoutId: 2 }, KILTER.uuid, GYM)).toBe(MOONBOARD);
    expect(findGymBoardForClimb({ boardName: 'moonboard', layoutId: 3 }, KILTER.uuid, GYM)).toBeNull();
  });
});
