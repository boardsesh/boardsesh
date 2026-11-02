// A Lock Screen or Dynamic Island Next / Previous opens or renews the
// keep-lighting window natively on iOS (2.7); this is how the drive store takes
// it on. An Android notification press arms the drive from JS instead.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveActivityLightingWindowSnapshot } from '../../../../modules/live-activity/src/index';

const analytics = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../../../lib/analytics', () => ({ track: analytics.track }));
// The native read is injected per call; the plugin never loads here.
vi.mock('../../../lib/live-activity/live-activity-plugin', () => ({
  readLiveActivityLightingWindow: () => null,
}));

import {
  enterDriveMode,
  getDriveMode,
  getLastDriveModeExitReason,
  markDriveLive,
  resetDriveModeForTests,
} from '../drive-mode-store';
import {
  adoptLockScreenLighting,
  armNotificationPressDrive,
  isUnsettledLockScreenLighting,
  resetLockScreenLightingForTests,
  resolveLockScreenAdoption,
} from '../lock-screen-lighting';

const NOW = 100_000;

function snapshot(overrides: Partial<LiveActivityLightingWindowSnapshot> = {}): LiveActivityLightingWindowSnapshot {
  return {
    sessionId: 'session-1',
    mode: 'window',
    endsAtMs: NOW + 30_000,
    windowSeconds: 45,
    family: 'general',
    source: 'lockScreen',
    updatedAtMs: NOW - 15_000,
    ...overrides,
  };
}

function liveWindow(expiresInMs: number): void {
  enterDriveMode({
    startedBy: 'tap',
    sessionId: 'session-1',
    boardId: 7,
    windowMs: 45_000,
    windowSetting: 'putOnBoardKeepsLighting',
  });
  markDriveLive({ now: NOW + expiresInMs - 45_000 });
}

const resolve = (snap: LiveActivityLightingWindowSnapshot | null, linked = true) =>
  resolveLockScreenAdoption({ snapshot: snap, drive: getDriveMode(), sessionId: 'session-1', linked, now: NOW });

beforeEach(() => {
  analytics.track.mockClear();
  resetLockScreenLightingForTests();
});
afterEach(() => resetDriveModeForTests());

describe('resolveLockScreenAdoption', () => {
  it('starts a live window from the press, ending where native said', () => {
    expect(resolve(snapshot({ family: 'moonboard' }))).toEqual({
      kind: 'start',
      windowMs: 45_000,
      windowSetting: 'moonboardPutOnBoardKeepsLighting',
      expiresAt: NOW + 30_000,
      startedAt: NOW - 15_000,
    });
  });

  it('starts an open-ended drive for a press that drove the wall', () => {
    expect(resolve(snapshot({ mode: 'driving', endsAtMs: undefined, windowSeconds: undefined }))).toEqual({
      kind: 'start',
      windowMs: null,
      windowSetting: null,
      expiresAt: null,
      startedAt: NOW - 15_000,
    });
  });

  it('falls back to the time left when native sent no length', () => {
    expect(resolve(snapshot({ windowSeconds: null }))).toMatchObject({ kind: 'start', windowMs: 30_000 });
  });

  it('extends a live window only to a later end', () => {
    liveWindow(10_000);
    expect(resolve(snapshot())).toEqual({ kind: 'extend', expiresAt: NOW + 30_000 });
    expect(resolve(snapshot({ endsAtMs: NOW + 5_000 }))).toEqual({ kind: 'none' });
  });

  // A pick reads the end off the wall clock (#7038): a window over by the
  // press is not one it renewed. Native found it over too and opened a new one.
  it('starts a drive of its own for a press after the window here ran out', () => {
    liveWindow(-20_000);
    expect(resolve(snapshot({ updatedAtMs: NOW - 10_000 }))).toEqual({
      kind: 'start',
      windowMs: 45_000,
      windowSetting: 'putOnBoardKeepsLighting',
      expiresAt: NOW + 30_000,
      startedAt: NOW - 10_000,
      replacesLapsedWindow: true,
    });
    expect(resolve(snapshot({ mode: 'driving', endsAtMs: null, updatedAtMs: NOW - 20_000 }))).toMatchObject({
      kind: 'start',
      windowMs: null,
      replacesLapsedWindow: true,
    });
  });

  it('extends a window that is over now when the press came before its end', () => {
    liveWindow(-20_000);
    expect(resolve(snapshot({ updatedAtMs: NOW - 25_000 }))).toEqual({ kind: 'extend', expiresAt: NOW + 30_000 });
  });

  it('opens a window up when the press drove the wall, and leaves a drive alone', () => {
    liveWindow(10_000);
    expect(resolve(snapshot({ mode: 'driving', endsAtMs: null }))).toEqual({ kind: 'open_ended' });
    resetDriveModeForTests();
    enterDriveMode({ startedBy: 'swipe', sessionId: 'session-1', boardId: 7 });
    markDriveLive();
    expect(resolve(snapshot({ mode: 'driving', endsAtMs: null }))).toEqual({ kind: 'none' });
    expect(resolve(snapshot())).toEqual({ kind: 'none' });
  });

  it('settles a window already over, or off, with nothing to do', () => {
    expect(resolve(snapshot({ endsAtMs: NOW }))).toEqual({ kind: 'none' });
    expect(resolve(snapshot({ mode: 'off', endsAtMs: null }))).toEqual({ kind: 'none' });
  });

  it('cannot judge it yet: the app wrote it, another session, no link, or a drive arming', () => {
    expect(resolve(null)).toBeNull();
    expect(resolve(snapshot({ source: 'app' }))).toBeNull();
    expect(resolve(snapshot({ sessionId: 'session-0' }))).toBeNull();
    expect(resolve(snapshot(), false)).toBeNull();
    expect(
      resolveLockScreenAdoption({ snapshot: snapshot(), drive: null, sessionId: null, linked: true, now: NOW }),
    ).toBeNull();
    enterDriveMode({ startedBy: 'tap', sessionId: 'session-1', boardId: 7, windowMs: 45_000 });
    expect(resolve(snapshot())).toBeNull();
  });
});

describe('adoptLockScreenLighting', () => {
  const context = { sessionId: 'session-1', linked: true, boardId: 7, boardType: 'kilter', now: NOW };

  it('adopts a press once, by its write time', () => {
    const read = () => snapshot();
    expect(adoptLockScreenLighting({ ...context, read })?.kind).toBe('start');
    expect(getDriveMode()).toMatchObject({ startedBy: 'lock_screen', expiresAt: NOW + 30_000, boardType: 'kilter' });
    resetDriveModeForTests();
    // The same write again: settled, so a drive the climber ended stays ended.
    expect(adoptLockScreenLighting({ ...context, read })).toBeNull();
    expect(getDriveMode()).toBeNull();
    // A newer press is adopted.
    expect(adoptLockScreenLighting({ ...context, read: () => snapshot({ updatedAtMs: NOW - 1 }) })?.kind).toBe('start');
  });

  it('ends a window that ran out before the press at its end, and starts the press’s own', () => {
    liveWindow(-20_000);
    const adoption = adoptLockScreenLighting({ ...context, read: () => snapshot({ updatedAtMs: NOW - 10_000 }) });
    expect(adoption).toMatchObject({ kind: 'start', replacesLapsedWindow: true });
    expect(analytics.track).toHaveBeenCalledWith(
      'Drive Mode Ended',
      expect.objectContaining({ reason: 'window_ended', startedBy: 'tap' }),
    );
    expect(getDriveMode()).toMatchObject({
      phase: 'live',
      startedBy: 'lock_screen',
      expiresAt: NOW + 30_000,
      windowRenewals: 0,
    });
  });

  it('leaves a write it cannot judge for the next try', () => {
    const read = () => snapshot();
    expect(adoptLockScreenLighting({ ...context, linked: false, read })).toBeNull();
    expect(adoptLockScreenLighting({ ...context, read })?.kind).toBe('start');
  });

  it('never adopts a write from before this JS started (a kill or a reload in between)', () => {
    resetLockScreenLightingForTests({ startedAt: NOW - 10_000 });
    expect(adoptLockScreenLighting({ ...context, read: () => snapshot({ updatedAtMs: NOW - 15_000 }) })).toBeNull();
    expect(
      adoptLockScreenLighting({ ...context, read: () => snapshot({ mode: 'driving', endsAtMs: null }) }),
    ).toBeNull();
    expect(getDriveMode()).toBeNull();
    // A press after the start is this JS's to adopt.
    expect(adoptLockScreenLighting({ ...context, read: () => snapshot({ updatedAtMs: NOW - 5_000 }) })?.kind).toBe(
      'start',
    );
  });
});

describe('isUnsettledLockScreenLighting', () => {
  it('guards a running lock-screen window or drive until it is settled', () => {
    expect(isUnsettledLockScreenLighting(snapshot(), NOW)).toBe(true);
    expect(isUnsettledLockScreenLighting(snapshot({ mode: 'driving', endsAtMs: null }), NOW)).toBe(true);
    expect(isUnsettledLockScreenLighting(snapshot({ endsAtMs: NOW }), NOW)).toBe(false);
    expect(isUnsettledLockScreenLighting(snapshot({ source: 'app' }), NOW)).toBe(false);
    expect(isUnsettledLockScreenLighting(null, NOW)).toBe(false);
    adoptLockScreenLighting({
      sessionId: 'session-1',
      linked: true,
      boardId: 7,
      boardType: null,
      now: NOW,
      read: () => snapshot(),
    });
    expect(isUnsettledLockScreenLighting(snapshot(), NOW)).toBe(false);
  });

  it('lets this JS cover a window or drive an earlier JS left unsettled', () => {
    resetLockScreenLightingForTests({ startedAt: NOW - 10_000 });
    expect(isUnsettledLockScreenLighting(snapshot(), NOW)).toBe(false);
    expect(isUnsettledLockScreenLighting(snapshot({ mode: 'driving', endsAtMs: null }), NOW)).toBe(false);
    expect(isUnsettledLockScreenLighting(snapshot({ updatedAtMs: NOW - 5_000 }), NOW)).toBe(true);
  });
});

describe('armNotificationPressDrive', () => {
  const press = {
    sessionId: 'session-1',
    boardId: 7,
    boardType: 'kilter',
    linked: true,
    plan: { windowMs: 45_000, setting: 'putOnBoardKeepsLighting' as const },
  };

  it('arms a window that the lit confirm starts', () => {
    expect(armNotificationPressDrive(press)).toBe(true);
    expect(getDriveMode()).toMatchObject({
      phase: 'arming',
      startedBy: 'lock_screen',
      windowMs: 45_000,
      windowSetting: 'putOnBoardKeepsLighting',
      expiresAt: null,
      boardType: 'kilter',
    });
    markDriveLive({ now: NOW });
    expect(getDriveMode()).toMatchObject({ phase: 'live', expiresAt: NOW + 45_000 });
  });

  it('arms an open-ended drive for Until I stop', () => {
    expect(
      armNotificationPressDrive({ ...press, plan: { windowMs: null, setting: 'moonboardPutOnBoardKeepsLighting' } }),
    ).toBe(true);
    expect(getDriveMode()).toMatchObject({ phase: 'arming', windowMs: null, windowSetting: null });
  });

  // Android pauses JS timers with the activity (#7038): the watcher may not
  // have ended a window that ran out. The press reads the end itself, so the
  // window's confirm can't renew it.
  it('ends a window past its end at the press, then arms the press’s own', () => {
    liveWindow(-1_000);
    expect(armNotificationPressDrive({ ...press, now: NOW })).toBe(true);
    expect(analytics.track).toHaveBeenCalledWith(
      'Drive Mode Ended',
      expect.objectContaining({ reason: 'window_ended', startedBy: 'tap' }),
    );
    expect(getDriveMode()).toMatchObject({ phase: 'arming', startedBy: 'lock_screen', windowRenewals: 0 });
  });

  it('ends a window past its end at a press that lights one climb, and arms nothing', () => {
    liveWindow(-1_000);
    expect(armNotificationPressDrive({ ...press, plan: null, now: NOW })).toBe(false);
    expect(getLastDriveModeExitReason()).toBe('window_ended');
    expect(getDriveMode()).toBeNull();
  });

  it('arms nothing without a link, for one-climb lighting, or with a drive on', () => {
    expect(armNotificationPressDrive({ ...press, linked: false })).toBe(false);
    expect(armNotificationPressDrive({ ...press, plan: null })).toBe(false);
    expect(getDriveMode()).toBeNull();
    liveWindow(10_000);
    const before = getDriveMode();
    expect(armNotificationPressDrive({ ...press, now: NOW })).toBe(false);
    expect(getDriveMode()).toBe(before);
  });
});
