// @vitest-environment jsdom
// Driving the wall (#7113): the in-memory store, and the one rule that ends a
// drive between two reads of the board connection.
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const analytics = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../../../lib/analytics', () => ({ track: analytics.track }));
import {
  clampWindowEnd,
  clearDrivingStopped,
  drivingAtPick,
  enterDriveMode,
  exitDriveMode,
  getDriveLightingSnapshot,
  getDriveMode,
  getLastDriveModeExitReason,
  isDriveWindowDue,
  isDrivingStoppedForLink,
  makeDriveOpenEnded,
  markDriveLive,
  noteDriveClimbLit,
  resetDriveModeForTests,
  resolveDriveModeExit,
  shouldEndWindowForSettings,
  stopDrivingForLink,
  subscribeDriveMode,
  useDriveLightingMode,
  useDriveMode,
  useDriveModePhase,
  useDriveWindowExpiresAt,
  useDriveWindowMs,
  useDrivingStoppedForLink,
  type DriveModeState,
  type DriveWatchSnapshot,
} from '../drive-mode-store';
import { registerAutoDisconnectDeadlineReader } from '../../../lib/auto-disconnect-deadline';

/** Only Drive Mode Ended, for the tests about it (Drive Mode Started fires at every enter). */
const endedCalls = () => analytics.track.mock.calls.filter(([name]) => name === 'Drive Mode Ended');

beforeEach(() => analytics.track.mockClear());
afterEach(() => resetDriveModeForTests());

describe('drive-mode store', () => {
  it('starts with nobody driving and nothing stopped', () => {
    expect(getDriveMode()).toBeNull();
    expect(isDrivingStoppedForLink()).toBe(false);
  });

  it('arms on a swipe, goes live once lit, and counts the climbs lit while live', () => {
    enterDriveMode({ startedBy: 'swipe', sessionId: 'session-1', boardId: null, now: 1_000 });
    expect(getDriveMode()).toEqual({
      phase: 'arming',
      sessionId: 'session-1',
      boardId: null,
      boardType: null,
      startedAt: 1_000,
      startedBy: 'swipe',
      climbsLit: 0,
      windowMs: null,
      windowSetting: null,
      expiresAt: null,
      windowRenewals: 0,
    });
    // Arming lights nothing yet.
    noteDriveClimbLit();
    expect(getDriveMode()?.climbsLit).toBe(0);
    markDriveLive({ boardId: 7 });
    expect(getDriveMode()).toMatchObject({ phase: 'live', boardId: 7, startedAt: 1_000, climbsLit: 0 });
    // A second read of the same live drive counts nothing.
    markDriveLive({ boardId: 7 });
    noteDriveClimbLit();
    noteDriveClimbLit();
    expect(getDriveMode()?.climbsLit).toBe(2);
  });

  it('keeps the board it knew when going live without one', () => {
    enterDriveMode({ startedBy: 'swipe', sessionId: null, boardId: 3 });
    markDriveLive();
    expect(getDriveMode()).toMatchObject({ phase: 'live', boardId: 3 });
  });

  it('does nothing going live with nobody driving', () => {
    markDriveLive({ boardId: 7 });
    expect(getDriveMode()).toBeNull();
  });

  it('ends a drive with its reason, and says what ended', () => {
    enterDriveMode({ startedBy: 'swipe', sessionId: null, boardId: 7, now: 5 });
    expect(exitDriveMode('link_dropped')).toMatchObject({ phase: 'arming', startedAt: 5 });
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('link_dropped');
    expect(exitDriveMode('signed_out')).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('link_dropped');
  });

  it('stops driving on a press and keeps the stop until the link drops', () => {
    enterDriveMode({ startedBy: 'swipe', sessionId: null, boardId: 7 });
    markDriveLive();
    expect(stopDrivingForLink()).toMatchObject({ phase: 'live' });
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('stopped');
    expect(isDrivingStoppedForLink()).toBe(true);
    clearDrivingStopped();
    expect(isDrivingStoppedForLink()).toBe(false);
  });

  // Solo with Light the board as I swipe on, nothing is in the store: the stop is what matters.
  it('records a stop with no drive in the store (solo, lighting on swipes)', () => {
    expect(stopDrivingForLink()).toBeNull();
    expect(isDrivingStoppedForLink()).toBe(true);
    expect(getLastDriveModeExitReason()).toBeNull();
  });

  it('lets a fresh swipe drive again after a stop', () => {
    stopDrivingForLink();
    enterDriveMode({ startedBy: 'swipe', sessionId: null, boardId: 7 });
    expect(isDrivingStoppedForLink()).toBe(false);
    expect(getDriveMode()?.phase).toBe('arming');
  });

  it('re-renders its readers on every change', () => {
    const drive = renderHook(() => useDriveMode());
    const phase = renderHook(() => useDriveModePhase());
    const stopped = renderHook(() => useDrivingStoppedForLink());
    expect(phase.result.current).toBe('off');
    act(() => enterDriveMode({ startedBy: 'swipe', sessionId: null, boardId: 7 }));
    expect(phase.result.current).toBe('arming');
    act(() => markDriveLive());
    expect(phase.result.current).toBe('live');
    expect(drive.result.current?.phase).toBe('live');
    act(() => {
      stopDrivingForLink();
    });
    expect(phase.result.current).toBe('off');
    expect(drive.result.current).toBeNull();
    expect(stopped.result.current).toBe(true);
  });
});

describe('Drive Mode Ended', () => {
  it('fires once when a drive ends, with how long it lasted and what it lit', () => {
    vi.spyOn(Date, 'now').mockReturnValue(31_400);
    enterDriveMode({ startedBy: 'swipe', sessionId: 'session-1', boardId: 7, boardType: 'moonboard', now: 1_000 });
    markDriveLive();
    noteDriveClimbLit();
    exitDriveMode('link_dropped');
    exitDriveMode('signed_out');
    expect(endedCalls()).toHaveLength(1);
    expect(analytics.track).toHaveBeenCalledWith('Drive Mode Ended', {
      reason: 'link_dropped',
      startedBy: 'swipe',
      durationSec: 30,
      climbsLit: 1,
      inSession: true,
      windowRenewals: 0,
      windowSec: null,
      boardType: 'moonboard',
    });
    vi.restoreAllMocks();
  });

  it('reports a press on the frosted button as stopped, and a solo stop with no drive as nothing', () => {
    stopDrivingForLink();
    expect(analytics.track).not.toHaveBeenCalled();
    enterDriveMode({ startedBy: 'swipe', sessionId: null, boardId: 7 });
    stopDrivingForLink();
    expect(analytics.track).toHaveBeenCalledWith(
      'Drive Mode Ended',
      expect.objectContaining({ reason: 'stopped', climbsLit: 0, inSession: false }),
    );
  });

  it.each(['tap', 'action', 'solo_carry'] as const)('says a drive was started by %s', (startedBy) => {
    enterDriveMode({ startedBy, sessionId: null, boardId: 7 });
    exitDriveMode('link_dropped');
    expect(analytics.track).toHaveBeenCalledWith('Drive Mode Ended', expect.objectContaining({ startedBy }));
  });

  it('reports a swipe whose connect failed', () => {
    enterDriveMode({ startedBy: 'swipe', sessionId: null, boardId: null });
    exitDriveMode('connect_failed');
    expect(analytics.track).toHaveBeenCalledWith(
      'Drive Mode Ended',
      expect.objectContaining({ reason: 'connect_failed', climbsLit: 0 }),
    );
  });
});

describe('resolveDriveModeExit', () => {
  const SNAPSHOT: DriveWatchSnapshot = {
    linked: true,
    pending: false,
    sessionId: 'session-1',
    boardId: 7,
    signedIn: true,
  };
  const LIVE: DriveModeState = {
    phase: 'live',
    sessionId: 'session-1',
    boardId: 7,
    boardType: 'kilter',
    startedAt: 0,
    startedBy: 'swipe',
    climbsLit: 0,
    windowMs: null,
    windowSetting: null,
    expiresAt: null,
    windowRenewals: 0,
  };
  const ARMING: DriveModeState = { ...LIVE, phase: 'arming', boardId: null };

  function exit(
    drive: DriveModeState,
    current: Partial<DriveWatchSnapshot>,
    previous: Partial<DriveWatchSnapshot> = {},
    connectSeen = false,
  ) {
    return resolveDriveModeExit({
      drive,
      previous: { ...SNAPSHOT, ...previous },
      current: { ...SNAPSHOT, ...current },
      connectSeen,
    });
  }

  it('keeps a live drive while nothing changes, in the background too', () => {
    expect(exit(LIVE, {})).toBeNull();
  });

  it.each([
    ['the link drops once live', LIVE, { linked: false }, {}, 'link_dropped'],
    ['the link drops while arming', ARMING, { linked: false }, {}, 'link_dropped'],
    ['the session changes', LIVE, { sessionId: 'session-2' }, {}, 'session_changed'],
    ['the climber leaves the session', LIVE, { sessionId: null }, {}, 'session_changed'],
    ['the session changes while arming', ARMING, { sessionId: 'session-2' }, {}, 'session_changed'],
    ['the board changes once live', LIVE, { boardId: 9 }, {}, 'board_changed'],
    ['the climber signs out', LIVE, { signedIn: false }, {}, 'signed_out'],
    ['the climber signs out while arming', ARMING, { signedIn: false }, {}, 'signed_out'],
  ] as const)('ends when %s', (_case, drive, current, previous, reason) => {
    expect(exit(drive, current, previous)).toBe(reason);
  });

  it('compares a live board against the one it learned before going live', () => {
    const unbound: DriveModeState = { ...LIVE, boardId: null };
    expect(exit(unbound, { boardId: 9 }, { boardId: 7 })).toBe('board_changed');
    expect(exit(unbound, { boardId: 7 }, { boardId: 7 })).toBeNull();
  });

  it('ignores a board binding on its way (null) once live; the link drop ends it instead', () => {
    expect(exit(LIVE, { boardId: null })).toBeNull();
  });

  it('lets the board resolve while arming', () => {
    expect(exit(ARMING, { boardId: 9, linked: true }, { boardId: null, linked: false })).toBeNull();
  });

  it('fails an arming drive only once its connect came and went without a link', () => {
    const notLinked = { linked: false, pending: false };
    // The swipe armed a beat before the connect started.
    expect(exit(ARMING, notLinked, { linked: false }, false)).toBeNull();
    // The connect is in flight.
    expect(exit(ARMING, { linked: false, pending: true }, { linked: false }, true)).toBeNull();
    // It ended without a link.
    expect(exit(ARMING, notLinked, { linked: false, pending: true }, true)).toBe('connect_failed');
    // It ended with a link: the runner marks it live.
    expect(exit(ARMING, { linked: true, pending: false }, { linked: false, pending: true }, true)).toBeNull();
  });

  it('puts sign-out first when several things change at once', () => {
    expect(exit(LIVE, { signedIn: false, linked: false, sessionId: null })).toBe('signed_out');
  });
});

describe('Drive Mode Started', () => {
  it('fires once at every start, before the drive reaches the wall, with what started it', () => {
    enterDriveMode({ startedBy: 'tap', sessionId: 'session-1', boardId: null, boardType: 'kilter', windowMs: 45_000 });
    expect(analytics.track).toHaveBeenCalledTimes(1);
    expect(analytics.track).toHaveBeenCalledWith('Drive Mode Started', {
      startedBy: 'tap',
      inSession: true,
      boardType: 'kilter',
    });
    // Going live and lighting climbs say nothing more.
    markDriveLive();
    noteDriveClimbLit();
    expect(analytics.track).toHaveBeenCalledTimes(1);
    enterDriveMode({ startedBy: 'swipe', sessionId: null, boardId: null });
    expect(analytics.track).toHaveBeenLastCalledWith('Drive Mode Started', {
      startedBy: 'swipe',
      inSession: false,
      boardType: null,
    });
  });
});

// Put on board's keep-lighting window (2.7): a live drive with an end.
describe('the keep-lighting window', () => {
  afterEach(() => registerAutoDisconnectDeadlineReader(() => null)());

  function openWindow(windowMs = 45_000, startedAt = 1_000) {
    enterDriveMode({
      startedBy: 'tap',
      sessionId: null,
      boardId: null,
      windowMs,
      windowSetting: 'putOnBoardKeepsLighting',
      now: startedAt,
    });
  }

  it('starts its clock at the lit confirm, not at the press', () => {
    openWindow(45_000, 1_000);
    expect(getDriveMode()).toMatchObject({ phase: 'arming', windowMs: 45_000, expiresAt: null });
    // The write took 4 s: the climber still gets the full 45.
    markDriveLive({ now: 5_000 });
    expect(getDriveMode()).toMatchObject({ phase: 'live', expiresAt: 50_000 });
  });

  it('renews on each climb that lights, counting every one after the first', () => {
    openWindow();
    markDriveLive({ now: 5_000 });
    // The confirm that made it live is counted as the first climb: no renewal.
    noteDriveClimbLit({ now: 5_000 });
    expect(getDriveMode()).toMatchObject({ climbsLit: 1, expiresAt: 50_000, windowRenewals: 0 });
    noteDriveClimbLit({ now: 20_000 });
    noteDriveClimbLit({ now: 40_000 });
    expect(getDriveMode()).toMatchObject({ climbsLit: 3, expiresAt: 85_000, windowRenewals: 2 });
    exitDriveMode('window_ended');
    expect(analytics.track).toHaveBeenLastCalledWith(
      'Drive Mode Ended',
      expect.objectContaining({
        reason: 'window_ended',
        startedBy: 'tap',
        climbsLit: 3,
        windowRenewals: 2,
        windowSec: 45,
      }),
    );
  });

  it('is due only once live and past its end', () => {
    openWindow();
    expect(isDriveWindowDue(getDriveMode(), 999_999)).toBe(false);
    markDriveLive({ now: 5_000 });
    expect(isDriveWindowDue(getDriveMode(), 49_999)).toBe(false);
    expect(isDriveWindowDue(getDriveMode(), 50_000)).toBe(true);
    // An open-ended drive is never due.
    enterDriveMode({ startedBy: 'swipe', sessionId: null, boardId: null });
    markDriveLive({ now: 5_000 });
    expect(isDriveWindowDue(getDriveMode(), Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  // #7038: Android pauses JS timers with the activity, so the watcher's end can
  // fire late. A pick reads the wall clock itself: past the end it lights
  // nothing, while the drive is still there for the watcher to tidy.
  describe('at the pick, past the end, before any timer has fired', () => {
    beforeEach(() => {
      vi.useFakeTimers({ now: 1_000 });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('a render that read a live drive lights nothing once the clock is past the window', () => {
      openWindow(45_000, 1_000);
      markDriveLive({ now: 5_000 });
      vi.setSystemTime(49_999);
      expect(drivingAtPick(true)).toBe(true);
      // Timers frozen: only the wall clock moves on.
      vi.setSystemTime(50_000);
      expect(drivingAtPick(true)).toBe(false);
      expect(getDriveMode()).toMatchObject({ phase: 'live', expiresAt: 50_000 });
      expect(endedCalls()).toEqual([]);
    });

    it('never turns a render that read no drive into one, and never ends an open-ended drive', () => {
      expect(drivingAtPick(false)).toBe(false);
      enterDriveMode({ startedBy: 'swipe', sessionId: null, boardId: null, now: 1_000 });
      markDriveLive({ now: 1_000 });
      vi.setSystemTime(Number.MAX_SAFE_INTEGER);
      expect(drivingAtPick(true)).toBe(true);
    });

    it('a window still arming is not past its end', () => {
      openWindow(45_000, 1_000);
      vi.setSystemTime(10 * 60_000);
      expect(drivingAtPick(true)).toBe(true);
    });
  });

  // The watcher can notice a lapsed window late (a paused timer, the app coming
  // back): Drive Mode Ended says when it really ended.
  it('reports a window that ran out as ending at its end, however late it is noticed', () => {
    openWindow(45_000, 1_000);
    markDriveLive({ now: 5_000 });
    noteDriveClimbLit({ now: 5_000 });
    // Noticed by a real clock far past 50_000.
    exitDriveMode('window_ended');
    expect(endedCalls().at(-1)?.[1]).toMatchObject({ reason: 'window_ended', durationSec: 49 });
  });

  it('reports a window whose setting was turned off as ending then', () => {
    vi.useFakeTimers({ now: 1_000 });
    try {
      openWindow(45_000, 1_000);
      markDriveLive({ now: 5_000 });
      vi.setSystemTime(21_000);
      exitDriveMode('window_ended');
      expect(endedCalls().at(-1)?.[1]).toMatchObject({ reason: 'window_ended', durationSec: 20 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('turns open-ended on a swipe or Light every climb, and stays the same drive', () => {
    openWindow();
    markDriveLive({ now: 5_000 });
    noteDriveClimbLit({ now: 5_000 });
    expect(makeDriveOpenEnded()).toBe(true);
    expect(getDriveMode()).toMatchObject({
      phase: 'live',
      startedAt: 1_000,
      startedBy: 'tap',
      climbsLit: 1,
      windowMs: null,
      windowSetting: null,
      expiresAt: null,
    });
    // A later climb no longer sets an end.
    noteDriveClimbLit({ now: 30_000 });
    expect(getDriveMode()?.expiresAt).toBeNull();
    // Nothing to open up a second time, or with no window at all.
    expect(makeDriveOpenEnded()).toBe(false);
    resetDriveModeForTests();
    expect(makeDriveOpenEnded()).toBe(false);
  });

  it('ignores a zero-length window: the drive is open-ended', () => {
    openWindow(0);
    markDriveLive({ now: 5_000 });
    expect(getDriveMode()).toMatchObject({ windowMs: null, expiresAt: null, windowSetting: null });
  });

  it('names the mode in one word for the board control and the native bridge', () => {
    const mode = renderHook(() => useDriveLightingMode());
    expect(mode.result.current).toBe('off');
    act(() => openWindow());
    expect(mode.result.current).toBe('arming');
    act(() => markDriveLive({ now: 5_000 }));
    expect(mode.result.current).toBe('window');
    act(() => {
      makeDriveOpenEnded();
    });
    expect(mode.result.current).toBe('driving');
  });

  it("hands a bridge { mode, endsAt }, the shown end clamped to auto-disconnect's", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDriveMode(listener);
    expect(getDriveLightingSnapshot()).toEqual({ mode: 'off', endsAt: null });
    openWindow();
    expect(getDriveLightingSnapshot()).toEqual({ mode: 'arming', endsAt: null });
    markDriveLive({ now: 5_000 });
    expect(getDriveLightingSnapshot()).toEqual({ mode: 'window', endsAt: 50_000 });
    // A 30 s auto-disconnect comes first: the window shows its end.
    const release = registerAutoDisconnectDeadlineReader(() => 35_000);
    expect(getDriveLightingSnapshot()).toEqual({ mode: 'window', endsAt: 35_000 });
    release();
    expect(getDriveLightingSnapshot().endsAt).toBe(50_000);
    makeDriveOpenEnded();
    expect(getDriveLightingSnapshot()).toEqual({ mode: 'driving', endsAt: null });
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it("hands the clock the window's end and length, re-rendering on a renewal and never on a count alone", () => {
    let renders = 0;
    const window = renderHook(() => {
      renders += 1;
      return { expiresAt: useDriveWindowExpiresAt(), windowMs: useDriveWindowMs() };
    });
    expect(window.result.current).toEqual({ expiresAt: null, windowMs: null });
    act(() => openWindow());
    // Arming: the length is known, the end is not.
    expect(window.result.current).toEqual({ expiresAt: null, windowMs: 45_000 });
    act(() => markDriveLive({ now: 5_000 }));
    expect(window.result.current).toEqual({ expiresAt: 50_000, windowMs: 45_000 });
    act(() => noteDriveClimbLit({ now: 9_000 }));
    expect(window.result.current.expiresAt).toBe(54_000);
    act(() => {
      makeDriveOpenEnded();
    });
    expect(window.result.current).toEqual({ expiresAt: null, windowMs: null });
    // An open-ended drive's climbs change nothing these readers show.
    const before = renders;
    act(() => {
      noteDriveClimbLit();
      noteDriveClimbLit();
    });
    expect(renders).toBe(before);
  });

  it('clamps the shown end only when auto-disconnect comes first', () => {
    expect(clampWindowEnd(50_000, null)).toBe(50_000);
    expect(clampWindowEnd(50_000, 35_000)).toBe(35_000);
    expect(clampWindowEnd(50_000, 60_000)).toBe(50_000);
  });

  it.each<[string, Partial<Parameters<typeof shouldEndWindowForSettings>[0]>, boolean]>([
    ['nothing changed', {}, false],
    ['its choice turned Off', { keepLighting: 'off' }, true],
    ['In a session too turned off, solo', { drivesInSession: false }, false],
    ['In a session too turned off, in a crew', { drivesInSession: false, inSession: true }, true],
    ["the MoonBoard's choice turned Off, which isn't its own", { moonboardKeepLighting: 'off' }, false],
  ])('ends a window from the general choice when %s: %s', (_name, change, ends) => {
    openWindow();
    markDriveLive({ now: 5_000 });
    expect(
      shouldEndWindowForSettings({
        drive: getDriveMode(),
        keepLighting: '45',
        moonboardKeepLighting: 'until_stopped',
        drivesInSession: true,
        inSession: false,
        ...change,
      }),
    ).toBe(ends);
  });

  it("ends a MoonBoard's window only on its own choice, in a crew too", () => {
    enterDriveMode({
      startedBy: 'tap',
      sessionId: 's',
      boardId: null,
      windowMs: 30_000,
      windowSetting: 'moonboardPutOnBoardKeepsLighting',
    });
    const base = {
      drive: getDriveMode(),
      keepLighting: 'off' as const,
      moonboardKeepLighting: '30' as const,
      drivesInSession: false,
      inSession: true,
    };
    expect(shouldEndWindowForSettings(base)).toBe(false);
    expect(shouldEndWindowForSettings({ ...base, moonboardKeepLighting: 'off' })).toBe(true);
    // An open-ended drive has no window to end.
    enterDriveMode({ startedBy: 'swipe', sessionId: null, boardId: null });
    expect(shouldEndWindowForSettings({ ...base, drive: getDriveMode(), moonboardKeepLighting: 'off' })).toBe(false);
  });
});
