// A lock-screen or notification Next / Previous opens or renews the
// keep-lighting window natively (2.7); this is how the drive store takes it on.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveActivityLightingWindowSnapshot } from '../../../../modules/live-activity/src/index';

const analytics = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../../../lib/analytics', () => ({ track: analytics.track }));
// The native read is injected per call; the plugin never loads here.
vi.mock('../../../lib/live-activity/live-activity-plugin', () => ({
  readLiveActivityLightingWindow: () => null,
}));

import { enterDriveMode, getDriveMode, markDriveLive, resetDriveModeForTests } from '../drive-mode-store';
import {
  adoptLockScreenLighting,
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

  it('leaves a write it cannot judge for the next try', () => {
    const read = () => snapshot();
    expect(adoptLockScreenLighting({ ...context, linked: false, read })).toBeNull();
    expect(adoptLockScreenLighting({ ...context, read })?.kind).toBe('start');
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
});
