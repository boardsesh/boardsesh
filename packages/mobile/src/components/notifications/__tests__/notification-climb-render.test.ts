import { describe, expect, it } from 'vitest';
import type { GroupedNotification } from '@boardsesh/shared-schema';
import { notificationClimbRender } from '../notification-climb-render';
import { notificationToClimb } from '../notification-to-climb';

// Both leaves sit on the critical path and are called from two places each, so
// they get direct tests rather than only the coverage they pick up through the
// row and screen suites:
//   - notificationClimbRender decides the leading slot AND the FlashList item
//     type. If those two ever disagreed, a thumbnail cell would be recycled into
//     an avatar row mid-scroll.
//   - notificationToClimb builds the Climb the drawer opens. A wrong field here
//     opens the drawer on a board with no holds lit.

function makeNotification(overrides: Partial<GroupedNotification> = {}): GroupedNotification {
  return {
    uuid: 'n1',
    type: 'new_climb',
    entityType: 'climb',
    entityId: 'C-1',
    actorCount: 1,
    actors: [{ id: 'u1', displayName: 'Alex', avatarUrl: null }],
    commentBody: null,
    climbName: 'Blue Ridge',
    climbUuid: 'C-1',
    boardType: 'kilter',
    climbLayoutId: 8,
    climbAngle: 40,
    climbFrames: 'p1080r12p1122r13',
    climbCompatibleSizeIds: null,
    threadEntityType: null,
    threadEntityId: null,
    proposalUuid: null,
    setterUsername: null,
    gymName: null,
    isRead: false,
    createdAt: '2026-09-06T10:00:00.000Z',
    ...overrides,
  } as GroupedNotification;
}

describe('notificationClimbRender', () => {
  it('resolves a board for a climb row that has frames', () => {
    const render = notificationClimbRender(makeNotification());

    expect(render).not.toBeNull();
    expect(render!.frames).toBe('p1080r12p1122r13');
    expect(render!.boardConfig.boardName).toBe('kilter');
    expect(render!.boardConfig.layoutId).toBe(8);
    expect(render!.boardConfig.setIds.length).toBeGreaterThan(0);
  });

  it('returns null without frames — a blank tile reads as broken', () => {
    expect(notificationClimbRender(makeNotification({ climbFrames: null }))).toBeNull();
  });

  it('returns null without a board type', () => {
    expect(notificationClimbRender(makeNotification({ boardType: null }))).toBeNull();
  });

  it('returns null when the layout is missing', () => {
    // Not merely defensive: the board helper tolerates a missing layout and
    // falls back to the layout default, which on a board that numbers holds per
    // size draws a DIFFERENT climb rather than failing.
    expect(notificationClimbRender(makeNotification({ climbLayoutId: null }))).toBeNull();
  });

  it('returns null for a board name that does not resolve', () => {
    expect(notificationClimbRender(makeNotification({ boardType: 'not-a-board' }))).toBeNull();
  });

  it('returns null for a row that is not about a climb at all', () => {
    const follower = makeNotification({
      type: 'new_follower',
      entityType: null,
      climbUuid: null,
      boardType: null,
      climbLayoutId: null,
      climbFrames: null,
    });

    expect(notificationClimbRender(follower)).toBeNull();
  });

  it('is stable across calls, so getItemType and the row cannot disagree', () => {
    // The list calls this per item and the row calls it again per render. Both
    // must reach the same verdict or FlashList pools the two shapes together.
    const notification = makeNotification();
    const first = notificationClimbRender(notification);
    const second = notificationClimbRender(notification);

    expect(second).toEqual(first);
    // Same board key, different row object — the memo must not key on identity.
    const sameBoardDifferentClimb = makeNotification({ uuid: 'n2', climbUuid: 'C-2', climbFrames: 'p9r1' });
    expect(notificationClimbRender(sameBoardDifferentClimb)!.boardConfig).toEqual(first!.boardConfig);
    expect(notificationClimbRender(sameBoardDifferentClimb)!.frames).toBe('p9r1');
  });
});

describe('notificationToClimb', () => {
  it('carries the fields the drawer draws the board from', () => {
    const climb = notificationToClimb(makeNotification(), 40);

    expect(climb).not.toBeNull();
    expect(climb!.uuid).toBe('C-1');
    expect(climb!.name).toBe('Blue Ridge');
    // Frames are what light the holds — the whole point of skipping the refetch.
    expect(climb!.frames).toBe('p1080r12p1122r13');
    expect(climb!.angle).toBe(40);
    expect(climb!.boardType).toBe('kilter');
    expect(climb!.layoutId).toBe(8);
  });

  it('takes the angle from the caller, not the payload', () => {
    // The nav hook walks a ladder (setter's angle, then the reader's board, then
    // the board default) and passes the winner in. Reading climbAngle here
    // instead would silently ignore the reader's own board.
    const climb = notificationToClimb(makeNotification({ climbAngle: 40 }), 25);

    expect(climb!.angle).toBe(25);
  });

  it('falls back to the uuid when the climb has no name', () => {
    expect(notificationToClimb(makeNotification({ climbName: null }), 40)!.name).toBe('C-1');
  });

  it('returns null without frames, so the caller uses the climb route instead', () => {
    expect(notificationToClimb(makeNotification({ climbFrames: null }), 40)).toBeNull();
  });

  it('returns null without a climb uuid', () => {
    expect(notificationToClimb(makeNotification({ climbUuid: null }), 40)).toBeNull();
  });
});
