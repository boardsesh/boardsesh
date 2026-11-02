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
        lightOnSwipe: true,
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
        lightOnSwipe: true,
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
      lightOnSwipe: false,
      boardType: 'tension',
      layoutId: 9,
    });
    expect(properties.sessionMode).toBe('solo');
    expect(properties.lightOnSwipe).toBe(false);
  });

  it('sends no layout id on a spray wall, whose layout id names the wall', () => {
    const { properties } = queueNavigation({
      direction: 'next',
      method: 'button',
      surface: 'player',
      outcome: 'moved',
      inSharedSession: false,
      lightOnSwipe: true,
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
      lightOnSwipe: true,
      boardType: 'my-home-wall',
      layoutId: undefined,
    });
    expect(properties.boardType).toBeNull();
    expect(properties.layoutId).toBeNull();
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
      lightOnSwipe: false,
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
    });
    expect(properties).toMatchObject({ reason: 'window_ended', durationSec: 45, windowRenewals: 0 });
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
    });
    expect(properties).toMatchObject({ durationSec: 0, climbsLit: 0, inSession: false, windowRenewals: 0 });
  });
});

describe('driveModeStarted', () => {
  it('names the event and carries what started it and whether in a session', () => {
    expect(driveModeStarted({ startedBy: 'tap', inSession: true })).toEqual({
      name: 'Drive Mode Started',
      properties: { startedBy: 'tap', inSession: true },
    });
    expect(driveModeStarted({ startedBy: 'swipe', inSession: false }).properties).toEqual({
      startedBy: 'swipe',
      inSession: false,
    });
  });
});
