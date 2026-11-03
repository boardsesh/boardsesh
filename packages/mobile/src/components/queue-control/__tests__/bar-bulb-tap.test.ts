// What a MiniPlayer bulb's tap does (owner, 2026-11-03): stop a drive it
// shows, drop a tap aimed at a stop that already happened, otherwise its own.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/analytics-wall-control', () => ({
  trackDriveModeStarted: vi.fn(),
  trackDriveModeEnded: vi.fn(),
  trackWallControlTapped: vi.fn(),
}));
vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../../lib/announce-queued', () => ({ announceQueued: vi.fn() }));

import { readBarBulbTap, resolveBarBulbTap } from '../bar-bulb-tap';
import {
  enterDriveMode,
  exitDriveMode,
  markDriveLive,
  resetDriveModeForTests,
  stopDrivingForLink,
} from '../../play-drawer/drive-mode-store';
import { DISCONNECT_TAP_GUARD_MS, WINDOW_END_TAP_GRACE_MS } from '../../play-drawer/drive-tap-guards';

describe('resolveBarBulbTap', () => {
  const now = 50_000;

  it('stops a drive the bulb shows, whatever ended before it', () => {
    expect(resolveBarBulbTap({ drawsDrive: true, lastEnded: null, lastEndedAt: null, now })).toBe('stop_driving');
    expect(resolveBarBulbTap({ drawsDrive: true, lastEnded: { reason: 'stopped' }, lastEndedAt: now - 1, now })).toBe(
      'stop_driving',
    );
  });

  it('is the bulb’s own tap with no drive and no recent end', () => {
    expect(resolveBarBulbTap({ drawsDrive: false, lastEnded: null, lastEndedAt: null, now })).toBe('own');
  });

  it.each([
    ['stopped', DISCONNECT_TAP_GUARD_MS],
    ['window_ended', WINDOW_END_TAP_GRACE_MS],
  ] as const)('after a %s end, holds a tap for %s ms, then lets it through', (reason, guardMs) => {
    const tap = (sinceEnd: number) =>
      resolveBarBulbTap({ drawsDrive: false, lastEnded: { reason }, lastEndedAt: now - sinceEnd, now });
    expect(tap(0)).toBe('held');
    expect(tap(guardMs - 1)).toBe('held');
    expect(tap(guardMs)).toBe('own');
  });

  it.each(['link_dropped', 'session_changed', 'always_off', 'arming_timed_out'] as const)(
    'never holds a tap after a %s end: the climber did not aim at a stop',
    (reason) => {
      expect(resolveBarBulbTap({ drawsDrive: false, lastEnded: { reason }, lastEndedAt: now, now })).toBe('own');
    },
  );

  it('ignores an end stamped in the future (the clock moved back)', () => {
    expect(resolveBarBulbTap({ drawsDrive: false, lastEnded: { reason: 'stopped' }, lastEndedAt: now + 10, now })).toBe(
      'own',
    );
  });
});

// Read at the press, from the store as it is now, not from the bar's last render.
describe('readBarBulbTap', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    resetDriveModeForTests();
  });
  afterEach(() => {
    resetDriveModeForTests();
    vi.useRealTimers();
  });

  function startDrive(windowMs: number | null) {
    enterDriveMode({
      startedBy: 'tap',
      sessionId: null,
      boardId: 7,
      windowMs,
      windowSetting: windowMs === null ? null : 'putOnBoardKeepsLighting',
    });
    markDriveLive();
  }

  it.each([45_000, null])('stops a live drive (window %s) only over this phone’s own lit link', (windowMs) => {
    startDrive(windowMs);
    expect(readBarBulbTap(true)).toBe('stop_driving');
    // A crewmate's board, a dropped link, or a wall with no lights: no cue, no stop.
    expect(readBarBulbTap(false)).toBe('own');
  });

  it('leaves an arming drive alone: nothing drives yet', () => {
    enterDriveMode({ startedBy: 'tap', sessionId: null, boardId: 7, windowMs: 45_000 });
    expect(readBarBulbTap(true)).toBe('own');
  });

  it('holds the tap after the drive ended between the render and the press', () => {
    startDrive(45_000);
    exitDriveMode('window_ended');
    expect(readBarBulbTap(true)).toBe('held');
    vi.advanceTimersByTime(WINDOW_END_TAP_GRACE_MS);
    expect(readBarBulbTap(true)).toBe('own');
  });

  it('holds the second tap of a double tap after a stop, from any surface', () => {
    startDrive(null);
    stopDrivingForLink();
    expect(readBarBulbTap(true)).toBe('held');
    vi.advanceTimersByTime(DISCONNECT_TAP_GUARD_MS);
    expect(readBarBulbTap(true)).toBe('own');
  });

  it('forgets the last end once a new drive starts', () => {
    startDrive(45_000);
    stopDrivingForLink();
    startDrive(null);
    expect(readBarBulbTap(false)).toBe('own');
  });
});
