// A Lock Screen or Dynamic Island Next / Previous starts or renews Put on
// board's timed drive natively on iOS (2.7); this is how the drive store takes
// it on. An Android notification press arms the drive from JS instead.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LiveActivityLightingWindowSnapshot,
  LiveActivityLockScreenPress,
} from '../../../../modules/live-activity/src/index';

const analytics = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../../../lib/analytics', () => ({ track: analytics.track }));
// The native read is injected per call; the plugin never loads here.
vi.mock('../../../lib/live-activity/live-activity-plugin', () => ({
  readLiveActivityLightingWindow: () => null,
  readLiveActivityLockScreenPress: () => null,
}));

import {
  enterDriveMode,
  getDriveMode,
  getLastDriveEnded,
  getLastDriveModeExitReason,
  isDrivingStoppedForLink,
  markDriveLive,
  resetDriveModeForTests,
  subscribeDriveEnded,
  type DriveEnded,
} from '../drive-mode-store';
import {
  adoptLockScreenLighting,
  armNotificationPressDrive,
  endTimedDriveAtClock,
  endTimedDriveOverAtPress,
  isUnsettledLockScreenLighting,
  isUnsettledLockScreenStop,
  LOCK_SCREEN_PRESS_MAX_IN_FLIGHT_MS,
  LOCK_SCREEN_PRESS_RECHECK_MS,
  resetLockScreenLightingForTests,
  resolveLockScreenAdoption,
  resolveTimedDriveEndAtClock,
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
  // A snapshot an older JS wrote with the MoonBoard family reads as Stop
  // driving after's window too: it is one choice for every board.
  it.each(['general', 'moonboard'] as const)(
    'starts a live window from the press, ending where native said (family %s)',
    (family) => {
      expect(resolve(snapshot({ family }))).toEqual({
        kind: 'start',
        windowMs: 45_000,
        windowSetting: 'putOnBoardKeepsLighting',
        expiresAt: NOW + 30_000,
        startedAt: NOW - 15_000,
      });
    },
  );

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

  // Disconnect Bluetooth when driving ends: the press is the climber lighting
  // a climb, so the old drive's end must keep the board. And the press's own
  // drive starts with no end on record, like any new drive.
  it('ends the timed drive the press found over keeping the link, and starts with no end on record', () => {
    const ends: DriveEnded[] = [];
    const unsubscribe = subscribeDriveEnded((ended) => ends.push(ended));
    liveWindow(-20_000);
    adoptLockScreenLighting({ ...context, read: () => snapshot({ updatedAtMs: NOW - 10_000 }) });
    unsubscribe();
    expect(ends).toEqual([expect.objectContaining({ reason: 'window_ended', keepLink: true })]);
    expect(getLastDriveEnded()).toBeNull();
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

// The Lock Screen bulb while this phone drives: StopDrivingIntent stores
// "off" from the lock screen, and the drive stops the way the frosted button
// stops it.
describe('a Lock Screen stop', () => {
  const stop = (overrides: Partial<LiveActivityLightingWindowSnapshot> = {}) =>
    snapshot({
      mode: 'off',
      endsAtMs: null,
      windowSeconds: null,
      family: null,
      updatedAtMs: NOW - 1_000,
      ...overrides,
    });
  const context = { sessionId: 'session-1', linked: true, boardId: 7, boardType: 'kilter', now: NOW };

  function driveStartedAt(startedAt: number): void {
    enterDriveMode({
      startedBy: 'tap',
      sessionId: 'session-1',
      boardId: 7,
      windowMs: 45_000,
      windowSetting: 'putOnBoardKeepsLighting',
      now: startedAt,
    });
    markDriveLive({ now: startedAt });
  }

  it('stops a drive that started before the tap, with or without a link', () => {
    driveStartedAt(NOW - 20_000);
    expect(resolve(stop())).toEqual({ kind: 'stop' });
    expect(resolve(stop(), false)).toEqual({ kind: 'stop' });
  });

  it('leaves a drive that started after the tap, and settles with no drive', () => {
    expect(resolve(stop())).toEqual({ kind: 'none' });
    driveStartedAt(NOW - 500);
    expect(resolve(stop())).toEqual({ kind: 'none' });
  });

  it('cannot judge another session’s stop', () => {
    driveStartedAt(NOW - 20_000);
    expect(resolve(stop({ sessionId: 'session-0' }))).toBeNull();
  });

  it('stops driving as the frosted button does, once', () => {
    const ends: DriveEnded[] = [];
    const unsubscribe = subscribeDriveEnded((ended) => ends.push(ended));
    driveStartedAt(NOW - 20_000);
    expect(adoptLockScreenLighting({ ...context, linked: false, read: () => stop() })).toEqual({ kind: 'stop' });
    unsubscribe();
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('stopped');
    expect(isDrivingStoppedForLink()).toBe(true);
    // Disconnect Bluetooth when driving ends then decides about the board.
    expect(ends).toEqual([expect.objectContaining({ reason: 'stopped', keepLink: false })]);
    expect(analytics.track).toHaveBeenCalledWith(
      'Drive Mode Ended',
      expect.objectContaining({ reason: 'stopped', startedBy: 'tap' }),
    );
    // Settled: a drive started since is not stopped by the same write.
    driveStartedAt(NOW - 20_000);
    expect(adoptLockScreenLighting({ ...context, read: () => stop() })).toBeNull();
    expect(getDriveMode()?.phase).toBe('live');
  });

  it('keeps the writer from putting the stopped drive back until it is adopted', () => {
    driveStartedAt(NOW - 20_000);
    expect(isUnsettledLockScreenStop(stop(), getDriveMode())).toBe(true);
    expect(isUnsettledLockScreenStop(stop({ source: 'app' }), getDriveMode())).toBe(false);
    expect(isUnsettledLockScreenStop(stop(), null)).toBe(false);
    expect(isUnsettledLockScreenStop(null, getDriveMode())).toBe(false);
    adoptLockScreenLighting({ ...context, read: () => stop() });
    driveStartedAt(NOW - 20_000);
    expect(isUnsettledLockScreenStop(stop(), getDriveMode())).toBe(false);
  });

  it('leaves a stop an earlier JS never adopted: a relaunch starts with nobody driving', () => {
    resetLockScreenLightingForTests({ startedAt: NOW });
    driveStartedAt(NOW - 20_000);
    expect(isUnsettledLockScreenStop(stop(), getDriveMode())).toBe(false);
    expect(adoptLockScreenLighting({ ...context, read: () => stop() })).toBeNull();
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

// A press JS hears, on either platform: under Right away the iOS intent writes
// no drive, so nothing else replaces a timed drive the press found over.
describe('endTimedDriveOverAtPress', () => {
  it('ends a timed drive past its end, keeping the link', () => {
    liveWindow(-1_000);
    expect(endTimedDriveOverAtPress(NOW)).toBe(true);
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveEnded()).toMatchObject({ reason: 'window_ended', keepLink: true });
  });

  it('leaves a timed drive with time left, an open-ended drive, and no drive alone', () => {
    expect(endTimedDriveOverAtPress(NOW)).toBe(false);
    liveWindow(1_000);
    expect(endTimedDriveOverAtPress(NOW)).toBe(false);
    expect(getDriveMode()).toMatchObject({ phase: 'live', expiresAt: NOW + 1_000 });
    resetDriveModeForTests();
    enterDriveMode({ startedBy: 'tap', sessionId: 'session-1', boardId: 7, windowMs: null, windowSetting: null });
    markDriveLive({ now: NOW - 600_000 });
    expect(endTimedDriveOverAtPress(NOW)).toBe(false);
    expect(getDriveMode()).toMatchObject({ phase: 'live', expiresAt: null });
  });
});

// iOS: the intent stamps a press in flight before its board write and settles
// it before JS hears it. The clock finding a timed drive over in that gap must
// not end it under the press (Disconnect Bluetooth when driving ends would let
// go of the board mid-press).
describe('resolveTimedDriveEndAtClock', () => {
  const END = NOW - 60_000;
  const inFlight = (expiresInMs: number): LiveActivityLockScreenPress => ({
    pressId: 'press-1',
    expiresAtMs: NOW + expiresInMs,
  });
  const at = (press: LiveActivityLockScreenPress | null) =>
    resolveTimedDriveEndAtClock({ press, expiresAt: END, now: NOW });

  it('ends at the clock with no press stamped', () => {
    expect(at(null)).toEqual({ kind: 'end' });
  });

  it('waits for a press in flight, looking again shortly or at its expiry, whichever is first', () => {
    expect(at(inFlight(8_000))).toEqual({ kind: 'wait', recheckInMs: LOCK_SCREEN_PRESS_RECHECK_MS });
    expect(at(inFlight(18_000))).toEqual({ kind: 'wait', recheckInMs: LOCK_SCREEN_PRESS_RECHECK_MS });
    expect(at(inFlight(100))).toEqual({ kind: 'wait', recheckInMs: 100 });
    expect(at({ ...inFlight(8_000), settledAtMs: null })).toMatchObject({ kind: 'wait' });
  });

  it('ends at the clock once an unsettled press expired: iOS ended the intent first', () => {
    expect(at(inFlight(0))).toEqual({ kind: 'end' });
    expect(at(inFlight(-1))).toEqual({ kind: 'end' });
  });

  it('never waits on a stamp claiming more than a press can take, or on garbage', () => {
    expect(at(inFlight(LOCK_SCREEN_PRESS_MAX_IN_FLIGHT_MS))).toMatchObject({ kind: 'wait' });
    // The clock moved back since the stamp: it would hold the end for an hour.
    expect(at(inFlight(LOCK_SCREEN_PRESS_MAX_IN_FLIGHT_MS + 1))).toEqual({ kind: 'end' });
    expect(at({ pressId: 'press-1', expiresAtMs: Number.NaN })).toEqual({ kind: 'end' });
  });

  it('ends keeping the board for a press that landed once the drive was over', () => {
    expect(at({ ...inFlight(8_000), settledAtMs: END })).toEqual({ kind: 'end_keeping_board' });
    expect(at({ ...inFlight(8_000), settledAtMs: NOW - 10 })).toEqual({ kind: 'end_keeping_board' });
    // Native stamps fractions of a millisecond; JS reads whole ones.
    expect(at({ ...inFlight(8_000), settledAtMs: NOW + 0.4 })).toEqual({ kind: 'end_keeping_board' });
  });

  it('ends at the clock for a press that landed before the end, or claims to land in the future', () => {
    // It renewed the drive natively; adoption already had its chance.
    expect(at({ ...inFlight(8_000), settledAtMs: END - 1 })).toEqual({ kind: 'end' });
    expect(at({ ...inFlight(8_000), settledAtMs: NOW + 60_000 })).toEqual({ kind: 'end' });
    expect(at({ ...inFlight(8_000), settledAtMs: Number.NaN })).toEqual({ kind: 'end' });
  });
});

describe('endTimedDriveAtClock', () => {
  it('leaves a timed drive alone while a press is in flight, and says when to look again', () => {
    liveWindow(-1_000);
    const readPress = () => ({ pressId: 'press-1', expiresAtMs: NOW + 8_000 });
    expect(endTimedDriveAtClock({ now: NOW, readPress })).toBe(LOCK_SCREEN_PRESS_RECHECK_MS);
    expect(getDriveMode()).toMatchObject({ phase: 'live', expiresAt: NOW - 1_000 });
  });

  it('ends it keeping the link once the press landed past its end', () => {
    liveWindow(-1_000);
    const readPress = () => ({ pressId: 'press-1', expiresAtMs: NOW + 8_000, settledAtMs: NOW - 200 });
    expect(endTimedDriveAtClock({ now: NOW, readPress })).toBeNull();
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveEnded()).toMatchObject({ reason: 'window_ended', keepLink: true });
  });

  it('ends it at the clock, free to let go of the board, with no press or one that expired', () => {
    for (const press of [null, { pressId: 'press-1', expiresAtMs: NOW - 1 }]) {
      resetDriveModeForTests();
      liveWindow(-1_000);
      expect(endTimedDriveAtClock({ now: NOW, readPress: () => press })).toBeNull();
      expect(getDriveMode()).toBeNull();
      expect(getLastDriveEnded()).toMatchObject({ reason: 'window_ended', keepLink: false });
    }
  });

  it('touches no drive with time left, no open-ended drive and no drive at all', () => {
    const readPress = vi.fn(() => null);
    expect(endTimedDriveAtClock({ now: NOW, readPress })).toBeNull();
    liveWindow(1_000);
    expect(endTimedDriveAtClock({ now: NOW, readPress })).toBeNull();
    expect(getDriveMode()).toMatchObject({ phase: 'live', expiresAt: NOW + 1_000 });
    resetDriveModeForTests();
    enterDriveMode({ startedBy: 'tap', sessionId: 'session-1', boardId: 7, windowMs: null, windowSetting: null });
    markDriveLive({ now: NOW - 600_000 });
    expect(endTimedDriveAtClock({ now: NOW, readPress })).toBeNull();
    expect(getDriveMode()).toMatchObject({ phase: 'live', expiresAt: null });
    expect(readPress).not.toHaveBeenCalled();
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
    expect(armNotificationPressDrive({ ...press, plan: { windowMs: null, setting: 'putOnBoardKeepsLighting' } })).toBe(
      true,
    );
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
    // The press is lighting a climb: Disconnect Bluetooth when driving ends keeps the board.
    expect(getLastDriveEnded()).toMatchObject({ reason: 'window_ended', keepLink: true });
  });

  it('keeps the link when it ends a timed drive past its end and arms its own', () => {
    const ends: DriveEnded[] = [];
    const unsubscribe = subscribeDriveEnded((ended) => ends.push(ended));
    liveWindow(-1_000);
    armNotificationPressDrive({ ...press, now: NOW });
    unsubscribe();
    expect(ends).toEqual([expect.objectContaining({ reason: 'window_ended', keepLink: true })]);
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
