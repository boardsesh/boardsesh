import { describe, expect, it } from 'vitest';
import { driveModeEnded, driveModeStarted, queueNavigation, queueSheetOpened } from '../queue-navigation-events';

describe('queueNavigation', () => {
  it('names the event www fired and carries the step, the session and the board', () => {
    expect(
      queueNavigation({
        direction: 'previous',
        method: 'swipe',
        surface: 'player',
        outcome: 'preview',
        inSharedSession: true,
        alwaysDrive: true,
        boardType: 'kilter',
        layoutId: 1,
      }),
    ).toEqual({
      name: 'Queue Navigation',
      properties: {
        direction: 'previous',
        method: 'swipe',
        surface: 'player',
        outcome: 'preview',
        sessionMode: 'party',
        alwaysDrive: true,
        driving: false,
        boardType: 'kilter',
        layoutId: 1,
      },
    });
  });

  it('reads solo outside a crew', () => {
    const { properties } = queueNavigation({
      direction: 'next',
      method: 'button',
      surface: 'mini_player',
      outcome: 'moved',
      inSharedSession: false,
      alwaysDrive: false,
      boardType: 'tension',
      layoutId: 9,
    });
    expect(properties.sessionMode).toBe('solo');
    expect(properties.alwaysDrive).toBe(false);
  });

  it('sends no layout id on a spray wall, whose layout id names the wall', () => {
    const { properties } = queueNavigation({
      direction: 'next',
      method: 'button',
      surface: 'player',
      outcome: 'moved',
      inSharedSession: false,
      alwaysDrive: true,
      boardType: 'spray',
      layoutId: 123456,
    });
    expect(properties.boardType).toBe('spray');
    expect(properties.layoutId).toBeNull();
  });

  it('sends null for a board it does not know, never the raw value', () => {
    const { properties } = queueNavigation({
      direction: 'next',
      method: 'button',
      surface: 'player',
      outcome: 'moved',
      inSharedSession: false,
      alwaysDrive: true,
      boardType: 'my-home-wall',
      layoutId: undefined,
    });
    expect(properties.boardType).toBeNull();
    expect(properties.layoutId).toBeNull();
  });
});

describe('queueNavigation for a swipe that went before its board had painted', () => {
  const swipe = {
    direction: 'next',
    method: 'swipe',
    surface: 'player',
    outcome: 'moved',
    inSharedSession: false,
    alwaysDrive: true,
    boardType: 'moonboard',
    layoutId: 2,
  } as const;

  it('says what the board was doing and how long the release waited, in whole milliseconds', () => {
    const { properties } = queueNavigation({ ...swipe, artWait: { artState: 'loading', waitedMs: 700.6 } });
    expect(properties).toMatchObject({ heldArtState: 'loading', heldMs: 701, boardType: 'moonboard' });
  });

  it('never sends a negative wait', () => {
    const { properties } = queueNavigation({ ...swipe, artWait: { artState: 'failed', waitedMs: -3 } });
    expect(properties).toMatchObject({ heldArtState: 'failed', heldMs: 0 });
  });

  it('adds nothing to an ordinary step', () => {
    const { properties } = queueNavigation(swipe);
    expect(properties).not.toHaveProperty('heldArtState');
    expect(properties).not.toHaveProperty('heldMs');
  });
});

describe('queueSheetOpened', () => {
  it('carries the surface and the board type only', () => {
    expect(queueSheetOpened({ surface: 'mini_player', boardType: 'moonboard' })).toEqual({
      name: 'Queue Sheet Opened',
      properties: { surface: 'mini_player', boardType: 'moonboard' },
    });
  });
});

describe('queueNavigation while driving the wall (#7113)', () => {
  it('says the step was driven, in a crew too', () => {
    const { properties } = queueNavigation({
      direction: 'next',
      method: 'swipe',
      surface: 'player',
      outcome: 'moved',
      inSharedSession: true,
      alwaysDrive: false,
      driving: true,
      boardType: 'kilter',
      layoutId: 1,
    });
    expect(properties).toMatchObject({ outcome: 'moved', sessionMode: 'party', driving: true });
  });
});

describe('driveModeEnded', () => {
  it('names the event and rounds the duration to whole seconds', () => {
    expect(
      driveModeEnded({
        reason: 'stopped',
        startedBy: 'tap',
        startedAt: 1_000,
        endedAt: 62_600,
        climbsLit: 5,
        inSession: true,
        windowRenewals: 3,
        windowMs: 45_000,
        boardType: 'moonboard',
      }),
    ).toEqual({
      name: 'Drive Mode Ended',
      properties: {
        reason: 'stopped',
        startedBy: 'tap',
        durationSec: 62,
        climbsLit: 5,
        inSession: true,
        windowRenewals: 3,
        windowSec: 45,
        boardType: 'moonboard',
      },
    });
  });

  it("reports Put on board's window running out", () => {
    const { properties } = driveModeEnded({
      reason: 'window_ended',
      startedBy: 'tap',
      startedAt: 0,
      endedAt: 45_000,
      climbsLit: 1,
      inSession: false,
      windowRenewals: 0,
      windowMs: 30_000,
      boardType: 'kilter',
    });
    expect(properties).toMatchObject({
      reason: 'window_ended',
      durationSec: 45,
      windowRenewals: 0,
      windowSec: 30,
      boardType: 'kilter',
    });
  });

  // Board plan item 8: who had the board after a drop the phone didn't cause.
  it('carries who took the board only when the caller knows it', () => {
    const base = {
      reason: 'link_dropped' as const,
      startedBy: 'always' as const,
      startedAt: 0,
      endedAt: 10_000,
      climbsLit: 2,
      inSession: true,
      windowRenewals: 0,
      windowMs: null,
      boardType: 'kilter',
    };
    expect(driveModeEnded({ ...base, takenBy: 'named' }).properties.takenBy).toBe('named');
    expect(driveModeEnded({ ...base, takenBy: 'anonymous' }).properties.takenBy).toBe('anonymous');
    // A plain drop: set, and null.
    const dropped = driveModeEnded({ ...base, takenBy: null }).properties;
    expect('takenBy' in dropped).toBe(true);
    expect(dropped.takenBy).toBeNull();
    // A hang-up mid-drive, or any other end: no key at all.
    expect('takenBy' in driveModeEnded(base).properties).toBe(false);
  });

  it('never reports a negative duration or count', () => {
    const { properties } = driveModeEnded({
      reason: 'connect_failed',
      startedBy: 'swipe',
      startedAt: 5_000,
      endedAt: 4_000,
      climbsLit: -1,
      inSession: false,
      windowRenewals: -2,
      windowMs: null,
      boardType: null,
    });
    expect(properties).toMatchObject({
      durationSec: 0,
      climbsLit: 0,
      inSession: false,
      windowRenewals: 0,
      windowSec: null,
      boardType: null,
    });
  });

  it("reports Always drive the wall's drive, turned off with the link kept", () => {
    expect(
      driveModeEnded({
        reason: 'always_off',
        startedBy: 'always',
        startedAt: 0,
        endedAt: 90_000,
        climbsLit: 4,
        inSession: false,
        windowRenewals: 0,
        windowMs: null,
        boardType: 'kilter',
      }).properties,
    ).toMatchObject({ reason: 'always_off', startedBy: 'always', durationSec: 90, climbsLit: 4, windowSec: null });
  });
});

describe('driveModeStarted', () => {
  it('names the event and carries what started it, whether in a session, and the board type', () => {
    expect(driveModeStarted({ startedBy: 'tap', inSession: true, boardType: 'moonboard' })).toEqual({
      name: 'Drive Mode Started',
      properties: { startedBy: 'tap', inSession: true, boardType: 'moonboard' },
    });
    expect(driveModeStarted({ startedBy: 'swipe', inSession: false, boardType: null }).properties).toEqual({
      startedBy: 'swipe',
      inSession: false,
      boardType: null,
    });
  });

  it('says Always drive the wall started it', () => {
    expect(driveModeStarted({ startedBy: 'always', inSession: true, boardType: 'tension' }).properties).toEqual({
      startedBy: 'always',
      inSession: true,
      boardType: 'tension',
    });
  });
});
