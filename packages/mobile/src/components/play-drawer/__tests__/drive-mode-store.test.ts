// @vitest-environment jsdom
// Driving the wall (#7113): the in-memory store, and the one rule that ends a
// drive between two reads of the board connection.
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const analytics = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../../../lib/analytics', () => ({ track: analytics.track }));
import {
  clearDrivingStopped,
  enterDriveMode,
  exitDriveMode,
  getDriveMode,
  getLastDriveModeExitReason,
  isDrivingStoppedForLink,
  markDriveLive,
  noteDriveClimbLit,
  resetDriveModeForTests,
  resolveDriveModeExit,
  stopDrivingForLink,
  useDriveMode,
  useDriveModePhase,
  useDrivingStoppedForLink,
  type DriveModeState,
  type DriveWatchSnapshot,
} from '../drive-mode-store';

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
      startedAt: 1_000,
      startedBy: 'swipe',
      climbsLit: 0,
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
    enterDriveMode({ startedBy: 'swipe', sessionId: 'session-1', boardId: 7, now: 1_000 });
    markDriveLive();
    noteDriveClimbLit();
    exitDriveMode('link_dropped');
    exitDriveMode('signed_out');
    expect(analytics.track).toHaveBeenCalledTimes(1);
    expect(analytics.track).toHaveBeenCalledWith('Drive Mode Ended', {
      reason: 'link_dropped',
      startedBy: 'swipe',
      durationSec: 30,
      climbsLit: 1,
      inSession: true,
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
    startedAt: 0,
    startedBy: 'swipe',
    climbsLit: 0,
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
