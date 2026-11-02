// @vitest-environment jsdom
// #7113: the one owner that ends a drive, mounted once in the root layout. It
// reads the Bluetooth link, the session, the bound board and sign-in.
import { act, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LiveActivityLightingWindowSnapshot,
  WidgetQueueNavigateEvent,
} from '../../../../modules/live-activity/src/index';

type QueueItemRead = { uuid: string; climb: { uuid: string; name: string } };
type Reads = {
  currentClimbQueueItem: QueueItemRead | null;
  isConnected: boolean;
  virtualWallHeld: boolean;
  loading: boolean;
  sessionId: string | null;
  boardId: number | null;
  isAuthenticated: boolean;
  lightOnSwipe: boolean;
  isCrew?: boolean;
  /** Settings › Board's keep-lighting (2.7). */
  keepLighting?: string;
  moonboardKeepLighting?: string;
  drivesInSession?: boolean;
  /** The swipe flag, keep-lighting's kill switch. */
  swipeToDrive?: boolean;
  /** The connected board's type. */
  boardName?: string;
  /** How many climbs the queue holds, for a notification press's index. */
  queueLength?: number;
};
const reads = vi.hoisted((): { current: Reads } => ({
  current: {
    currentClimbQueueItem: null,
    isConnected: false,
    virtualWallHeld: false,
    loading: false,
    sessionId: null,
    boardId: null,
    isAuthenticated: true,
    lightOnSwipe: true,
  },
}));
vi.mock('../../../providers/bluetooth-provider', () => ({
  useOptionalBluetoothContext: () => ({
    isConnected: reads.current.isConnected,
    virtualWallHeld: reads.current.virtualWallHeld,
    loading: reads.current.loading,
    boardName: reads.current.boardName ?? 'moonboard',
  }),
}));
vi.mock('../../../providers/feature-flags-provider', () => ({
  useWallSwipeToDriveEnabled: () => reads.current.swipeToDrive ?? true,
}));
// The queue is read narrowly: the current climb's uuid as the trigger, the
// snapshot for the item. A stable snapshot reader, like the provider's.
const getQueueSnapshot = () => ({
  queue: Array.from({ length: reads.current.queueLength ?? 0 }, (_, index) => ({ uuid: `item-${index}` })),
  currentClimbQueueItem: reads.current.currentClimbQueueItem,
});
vi.mock('../../../providers/queue-provider', () => ({
  useQueueSessionControls: () => ({ sessionId: reads.current.sessionId }),
  useIsCrewSession: () => reads.current.isCrew ?? false,
  useActiveClimbUuid: () => reads.current.currentClimbQueueItem?.climb.uuid ?? null,
  useQueueActions: () => ({ getQueueSnapshot }),
}));
const effects = vi.hoisted(() => ({
  hapticLight: vi.fn(),
  hapticSuccess: vi.fn(),
  announceQueued: vi.fn(),
  track: vi.fn(),
}));
vi.mock('../../../lib/haptics', () => ({ hapticLight: effects.hapticLight, hapticSuccess: effects.hapticSuccess }));
vi.mock('../../../lib/announce-queued', () => ({ announceQueued: effects.announceQueued }));
vi.mock('../../../lib/analytics', () => ({ track: effects.track }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => (values ? `${key} ${JSON.stringify(values)}` : key),
  }),
}));
vi.mock('../../../providers/board-presence-provider', () => ({
  useBoardPresenceControls: () => ({ boardId: reads.current.boardId }),
}));
vi.mock('../../../settings', () => ({
  useSetting: (key: string) => {
    switch (key) {
      case 'putOnBoardKeepsLighting':
        return [reads.current.keepLighting ?? '45', vi.fn()];
      case 'moonboardPutOnBoardKeepsLighting':
        return [reads.current.moonboardKeepLighting ?? 'until_stopped', vi.fn()];
      case 'putOnBoardDrivesInSession':
        return [reads.current.drivesInSession ?? true, vi.fn()];
      default:
        return [reads.current.lightOnSwipe, vi.fn()];
    }
  },
}));
// The foreground catch-up: the test plays the app coming back.
const appState = vi.hoisted(() => ({ listeners: new Set<(state: string) => void>() }));
vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_type: string, listener: (state: string) => void) => {
      appState.listeners.add(listener);
      return { remove: () => appState.listeners.delete(listener) };
    },
  },
}));
// The stored keep-lighting window an iOS lock-screen press writes natively
// (2.7), the press's queueNavigate event, and which platform hears it.
const lockScreen = vi.hoisted(() => ({
  snapshot: null as LiveActivityLightingWindowSnapshot | null,
  navigateListeners: new Set<(event: WidgetQueueNavigateEvent) => void>(),
  android: false,
}));
vi.mock('../../../lib/live-activity/live-activity-plugin', () => ({
  readLiveActivityLightingWindow: () => lockScreen.snapshot,
  addWidgetQueueNavigateListener: (listener: (event: WidgetQueueNavigateEvent) => void) => {
    lockScreen.navigateListeners.add(listener);
    return () => {
      lockScreen.navigateListeners.delete(listener);
    };
  },
  get isAndroidSessionPresence() {
    return lockScreen.android;
  },
}));
vi.mock('../../../providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: reads.current.isAuthenticated }),
}));

import { emitWallConfirm } from '@boardsesh/play-view';
import { DriveModeWatcher } from '../DriveModeWatcher';
import { noteOwnMove, noteRelayReceipt, clearRelayReceipt } from '../../../lib/relay-receipt';
import { CREW_PUT_UP_NOTICE_MS, clearCrewPutUp, getCrewPutUp } from '../crew-put-up-store';
import { resetLockScreenLightingForTests } from '../lock-screen-lighting';
import {
  DRIVE_ARMING_TIMEOUT_MS,
  enterDriveMode,
  exitDriveMode,
  getDriveMode,
  getLastDriveModeExitReason,
  isDrivingStoppedForLink,
  markDriveLive,
  resetDriveModeForTests,
  stopDrivingForLink,
} from '../drive-mode-store';

const DEFAULT_READS: Reads = {
  currentClimbQueueItem: null,
  isConnected: true,
  virtualWallHeld: false,
  loading: false,
  sessionId: 'session-1',
  boardId: 7,
  isAuthenticated: true,
  lightOnSwipe: true,
};

function mount() {
  const view = render(createElement(DriveModeWatcher));
  return {
    change(next: Partial<Reads>) {
      act(() => {
        reads.current = { ...reads.current, ...next };
        view.rerender(createElement(DriveModeWatcher));
      });
    },
  };
}

function driveLive() {
  act(() => {
    enterDriveMode({ startedBy: 'swipe', sessionId: reads.current.sessionId, boardId: reads.current.boardId });
    markDriveLive();
  });
}

beforeEach(() => {
  reads.current = { ...DEFAULT_READS };
  resetDriveModeForTests();
  lockScreen.snapshot = null;
  lockScreen.android = false;
  resetLockScreenLightingForTests();
  clearRelayReceipt();
  clearCrewPutUp();
  for (const effect of Object.values(effects)) effect.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  resetDriveModeForTests();
  clearCrewPutUp();
});

describe('DriveModeWatcher', () => {
  it.each([
    ['the link drops', { isConnected: false }, 'link_dropped'],
    ['the session changes', { sessionId: 'session-2' }, 'session_changed'],
    ['the board changes', { boardId: 9 }, 'board_changed'],
    ['the climber signs out', { isAuthenticated: false }, 'signed_out'],
  ] as const)('ends a live drive when %s', (_case, change, reason) => {
    const watcher = mount();
    driveLive();
    watcher.change({});
    expect(getDriveMode()?.phase).toBe('live');
    watcher.change(change);
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe(reason);
  });

  it('ends a drive on a wall with no lights when the hold is let go', () => {
    reads.current = { ...reads.current, isConnected: false, virtualWallHeld: true };
    const watcher = mount();
    driveLive();
    watcher.change({ virtualWallHeld: false });
    expect(getLastDriveModeExitReason()).toBe('link_dropped');
  });

  it('fails arming when the swipe’s connect comes and goes without a link', () => {
    reads.current = { ...reads.current, isConnected: false, boardId: null };
    const watcher = mount();
    act(() => enterDriveMode({ startedBy: 'swipe', sessionId: 'session-1', boardId: null }));
    // A beat before the connect starts: still arming.
    watcher.change({});
    expect(getDriveMode()?.phase).toBe('arming');
    watcher.change({ loading: true });
    expect(getDriveMode()?.phase).toBe('arming');
    watcher.change({ loading: false });
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('connect_failed');
  });

  it('keeps arming through a connect that links, and the board it resolves', () => {
    reads.current = { ...reads.current, isConnected: false, boardId: null };
    const watcher = mount();
    act(() => enterDriveMode({ startedBy: 'swipe', sessionId: 'session-1', boardId: null }));
    watcher.change({ loading: true });
    watcher.change({ loading: false, isConnected: true, boardId: 7 });
    expect(getDriveMode()?.phase).toBe('arming');
    act(() => markDriveLive({ boardId: 7 }));
    watcher.change({});
    expect(getDriveMode()?.phase).toBe('live');
  });

  it('gives up arming that never reaches the wall', () => {
    vi.useFakeTimers();
    mount();
    act(() => enterDriveMode({ startedBy: 'swipe', sessionId: 'session-1', boardId: 7 }));
    act(() => {
      vi.advanceTimersByTime(DRIVE_ARMING_TIMEOUT_MS - 1);
    });
    expect(getDriveMode()?.phase).toBe('arming');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(getLastDriveModeExitReason()).toBe('arming_timed_out');
  });

  it('never times out a live drive', () => {
    vi.useFakeTimers();
    mount();
    driveLive();
    act(() => {
      vi.advanceTimersByTime(DRIVE_ARMING_TIMEOUT_MS * 4);
    });
    expect(getDriveMode()?.phase).toBe('live');
  });

  it('lets go of a stop once its link drops, and not before', () => {
    const watcher = mount();
    act(() => {
      stopDrivingForLink();
    });
    watcher.change({ boardId: 9 });
    expect(isDrivingStoppedForLink()).toBe(true);
    watcher.change({ isConnected: false });
    expect(isDrivingStoppedForLink()).toBe(false);
  });

  it('lets go of a stop when Light the board as I swipe changes', () => {
    const watcher = mount();
    act(() => {
      stopDrivingForLink();
    });
    watcher.change({});
    expect(isDrivingStoppedForLink()).toBe(true);
    watcher.change({ lightOnSwipe: false });
    expect(isDrivingStoppedForLink()).toBe(false);
  });
});

function queueItem(uuid: string, name: string): QueueItemRead {
  return { uuid, climb: { uuid: `climb-${uuid}`, name } };
}

function crewMove(uuid: string) {
  noteRelayReceipt({
    eventType: 'CurrentClimbChanged',
    incomingQueueItemUuid: uuid,
    localQueueItemUuid: reads.current.currentClimbQueueItem?.uuid,
  });
}

// #7113: a crewmate puts a climb up while this phone drives the wall.
describe('DriveModeWatcher: a crewmate puts a climb up', () => {
  it('says so for 4 s, naming nobody, with a light buzz and one announcement, and keeps driving', () => {
    vi.useFakeTimers();
    reads.current = { ...reads.current, currentClimbQueueItem: queueItem('q-1', 'Mine') };
    const watcher = mount();
    driveLive();
    crewMove('q-2');
    watcher.change({ currentClimbQueueItem: queueItem('q-2', 'Crimp Ladder') });
    expect(getCrewPutUp()).toEqual({ climbName: 'Crimp Ladder', queueItemUuid: 'q-2' });
    expect(effects.hapticLight).toHaveBeenCalledOnce();
    expect(effects.announceQueued).toHaveBeenCalledOnce();
    expect(effects.announceQueued).toHaveBeenCalledWith('playView.wallControl.crewPutUp {"climb":"Crimp Ladder"}');
    expect(getDriveMode()?.phase).toBe('live');
    // A re-render with the same climb says nothing more.
    watcher.change({});
    expect(effects.announceQueued).toHaveBeenCalledOnce();
    act(() => {
      vi.advanceTimersByTime(CREW_PUT_UP_NOTICE_MS);
    });
    expect(getCrewPutUp()).toBeNull();
  });

  it('drops a crewmate’s move the driver’s own swipe overtook, and never says it later', () => {
    reads.current = { ...reads.current, currentClimbQueueItem: queueItem('q-1', 'Mine') };
    const watcher = mount();
    driveLive();
    // One batch: the crewmate's move to X, then the driver's swipe to Z.
    crewMove('q-x');
    noteOwnMove('q-z');
    watcher.change({ currentClimbQueueItem: queueItem('q-z', 'Swiped') });
    expect(getCrewPutUp()).toBeNull();
    // Prev back to X: the driver's own step, not the crewmate's.
    noteOwnMove('q-x');
    watcher.change({ currentClimbQueueItem: queueItem('q-x', 'Crew climb') });
    expect(getCrewPutUp()).toBeNull();
    expect(effects.announceQueued).not.toHaveBeenCalled();
  });

  it('says nothing for this phone’s own move, or when not driving', () => {
    const watcher = mount();
    driveLive();
    noteOwnMove('q-own');
    crewMove('q-own');
    watcher.change({ currentClimbQueueItem: queueItem('q-own', 'Own') });
    expect(getCrewPutUp()).toBeNull();

    act(() => {
      stopDrivingForLink();
    });
    crewMove('q-4');
    watcher.change({ currentClimbQueueItem: queueItem('q-4', 'Other') });
    expect(getCrewPutUp()).toBeNull();
    expect(effects.hapticLight).not.toHaveBeenCalled();
  });

  it('drops the line when the drive ends', () => {
    const watcher = mount();
    driveLive();
    crewMove('q-5');
    watcher.change({ currentClimbQueueItem: queueItem('q-5', 'Slab') });
    expect(getCrewPutUp()).not.toBeNull();
    watcher.change({ isConnected: false });
    expect(getCrewPutUp()).toBeNull();
  });
});

// Going live and counting what lit, from this phone's own link's confirms.
describe('DriveModeWatcher: the wall confirms', () => {
  it('goes live at the first confirm on this phone’s link, with the player closed', () => {
    mount();
    act(() => enterDriveMode({ startedBy: 'swipe', sessionId: 'session-1', boardId: 7 }));
    expect(getDriveMode()?.phase).toBe('arming');
    act(() => emitWallConfirm('climb-a'));
    expect(getDriveMode()).toMatchObject({ phase: 'live', climbsLit: 1 });
    expect(effects.hapticSuccess).toHaveBeenCalledOnce();
  });

  it('never goes live on a confirm without this phone’s link', () => {
    reads.current = { ...reads.current, isConnected: false };
    mount();
    act(() => enterDriveMode({ startedBy: 'swipe', sessionId: 'session-1', boardId: 7 }));
    act(() => emitWallConfirm('climb-a'));
    expect(getDriveMode()).toMatchObject({ phase: 'arming', climbsLit: 0 });
  });

  it('counts each new climb lit once, the swipe’s own first; re-sends and echoes are not new', () => {
    mount();
    act(() => enterDriveMode({ startedBy: 'swipe', sessionId: 'session-1', boardId: 7 }));
    act(() => {
      emitWallConfirm('climb-a');
      // The crew feed's echo of the same write.
      emitWallConfirm('climb-a');
      emitWallConfirm('climb-b');
      emitWallConfirm('climb-c');
      emitWallConfirm('climb-c');
    });
    expect(getDriveMode()?.climbsLit).toBe(3);
    // Prev back to a climb lit before is lit again.
    act(() => emitWallConfirm('climb-b'));
    expect(getDriveMode()?.climbsLit).toBe(4);
  });

  it('counts nothing with nobody driving, and starts over for a new drive', () => {
    mount();
    act(() => emitWallConfirm('climb-a'));
    act(() => {
      enterDriveMode({ startedBy: 'swipe', sessionId: 'session-1', boardId: 7, now: 1 });
      emitWallConfirm('climb-a');
      exitDriveMode('link_dropped');
      enterDriveMode({ startedBy: 'swipe', sessionId: 'session-1', boardId: 7, now: 2 });
      emitWallConfirm('climb-a');
    });
    expect(getDriveMode()?.climbsLit).toBe(1);
  });

  it('learns the bound board once live, so a later change of board ends the drive', () => {
    const watcher = mount();
    act(() => {
      enterDriveMode({ startedBy: 'swipe', sessionId: 'session-1', boardId: null });
      markDriveLive();
    });
    watcher.change({});
    expect(getDriveMode()?.boardId).toBe(7);
    watcher.change({ boardId: 9 });
    expect(getLastDriveModeExitReason()).toBe('board_changed');
  });
});

// #7113 QA (Marco: keep driving): a crew forming carries solo driving into it.
describe('DriveModeWatcher: a crew forms', () => {
  beforeEach(() => {
    resetDriveModeForTests();
    reads.current = { ...DEFAULT_READS, isCrew: false };
  });
  afterEach(() => resetDriveModeForTests());

  it('turns solo, setting-driven driving into a live drive', () => {
    const view = mount();
    expect(getDriveMode()).toBeNull();
    view.change({ isCrew: true });
    expect(getDriveMode()).toMatchObject({
      phase: 'live',
      sessionId: 'session-1',
      boardId: 7,
      // The linked board's type, for Drive Mode Started / Ended.
      boardType: 'moonboard',
      startedBy: 'solo_carry',
    });
    // It stays: the same session, the same board.
    view.change({ boardId: 7 });
    expect(getDriveMode()?.phase).toBe('live');
  });

  it('leaves a stopped climber previewing', () => {
    stopDrivingForLink();
    const view = mount();
    view.change({ isCrew: true });
    expect(getDriveMode()).toBeNull();
    expect(isDrivingStoppedForLink()).toBe(true);
  });

  it('carries nothing without a link, or with Light the board as I swipe off', () => {
    const unlinked = mount();
    unlinked.change({ isConnected: false });
    unlinked.change({ isCrew: true });
    expect(getDriveMode()).toBeNull();
    resetDriveModeForTests();
    reads.current = { ...DEFAULT_READS, isCrew: false, lightOnSwipe: false };
    const settingOff = mount();
    settingOff.change({ isCrew: true });
    expect(getDriveMode()).toBeNull();
  });

  it('keeps a drive a press started live, as it was', () => {
    act(() => {
      enterDriveMode({ startedBy: 'tap', sessionId: 'session-1', boardId: 7 });
      markDriveLive();
    });
    const startedAt = getDriveMode()?.startedAt;
    const view = mount();
    view.change({ isCrew: true });
    expect(getDriveMode()).toMatchObject({ phase: 'live', startedBy: 'tap', startedAt });
  });
});

// Put on board's keep-lighting window (2.7): one timeout to its end, re-keyed by
// each renewal, a catch-up on the foreground, and its setting turned off.
describe('DriveModeWatcher: the keep-lighting window', () => {
  function openWindow(windowMs = 45_000) {
    act(() => {
      enterDriveMode({
        startedBy: 'tap',
        sessionId: reads.current.sessionId,
        boardId: reads.current.boardId,
        windowMs,
        windowSetting: 'putOnBoardKeepsLighting',
      });
    });
  }

  it('ends the window at its end, and not a moment before', () => {
    vi.useFakeTimers();
    mount();
    openWindow();
    act(() => emitWallConfirm('climb-a'));
    expect(getDriveMode()).toMatchObject({ phase: 'live', climbsLit: 1 });
    act(() => {
      vi.advanceTimersByTime(45_000 - 1);
    });
    expect(getDriveMode()?.phase).toBe('live');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('window_ended');
    // The link stays, and nothing was stopped: the next pick is a plain preview.
    expect(isDrivingStoppedForLink()).toBe(false);
  });

  it('restarts the clock on each climb that lights', () => {
    vi.useFakeTimers();
    mount();
    openWindow();
    act(() => emitWallConfirm('climb-a'));
    act(() => {
      vi.advanceTimersByTime(40_000);
    });
    act(() => emitWallConfirm('climb-b'));
    act(() => {
      vi.advanceTimersByTime(40_000);
    });
    expect(getDriveMode()).toMatchObject({ phase: 'live', climbsLit: 2, windowRenewals: 1 });
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(getLastDriveModeExitReason()).toBe('window_ended');
  });

  it('waits out the rest when its timer fires early', () => {
    vi.useFakeTimers();
    mount();
    openWindow();
    act(() => emitWallConfirm('climb-a'));
    // The clock moved back 3 s under the timer (a time-zone or NTP step).
    vi.setSystemTime(Date.now() - 3_000);
    act(() => {
      vi.advanceTimersByTime(45_000);
    });
    expect(getDriveMode()?.phase).toBe('live');
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(getLastDriveModeExitReason()).toBe('window_ended');
  });

  it('catches up the moment the app comes back after its end passed in the background', () => {
    vi.useFakeTimers();
    mount();
    openWindow();
    act(() => emitWallConfirm('climb-a'));
    // Suspended: the wall clock moves on, the timer does not run.
    vi.setSystemTime(Date.now() + 60_000);
    act(() => {
      for (const listener of appState.listeners) listener('background');
    });
    expect(getDriveMode()?.phase).toBe('live');
    act(() => {
      for (const listener of appState.listeners) listener('active');
    });
    expect(getLastDriveModeExitReason()).toBe('window_ended');
  });

  it('keeps a window that still has time when the app comes back', () => {
    vi.useFakeTimers();
    mount();
    openWindow();
    act(() => emitWallConfirm('climb-a'));
    vi.setSystemTime(Date.now() + 10_000);
    act(() => {
      for (const listener of appState.listeners) listener('active');
    });
    expect(getDriveMode()?.phase).toBe('live');
  });

  it('never times out an open-ended drive', () => {
    vi.useFakeTimers();
    mount();
    driveLive();
    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
      for (const listener of appState.listeners) listener('active');
    });
    expect(getDriveMode()?.phase).toBe('live');
  });

  it('ends the window when its setting is turned Off', () => {
    const watcher = mount();
    openWindow();
    act(() => emitWallConfirm('climb-a'));
    watcher.change({ keepLighting: '30' });
    expect(getDriveMode()?.phase).toBe('live');
    watcher.change({ keepLighting: 'off' });
    expect(getLastDriveModeExitReason()).toBe('window_ended');
  });

  it('ends the window in a crew when In a session too is turned off, and not solo', () => {
    const watcher = mount();
    openWindow();
    act(() => emitWallConfirm('climb-a'));
    watcher.change({ drivesInSession: false });
    expect(getDriveMode()?.phase).toBe('live');
    watcher.change({ isCrew: true });
    expect(getLastDriveModeExitReason()).toBe('window_ended');
  });

  it('drops its timer once the window ends another way', () => {
    vi.useFakeTimers();
    const watcher = mount();
    // The lock-screen adoption listens for the foreground all the time.
    const alwaysListening = appState.listeners.size;
    openWindow();
    act(() => emitWallConfirm('climb-a'));
    watcher.change({ isConnected: false });
    expect(getLastDriveModeExitReason()).toBe('link_dropped');
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(getLastDriveModeExitReason()).toBe('link_dropped');
    expect(appState.listeners.size).toBe(alwaysListening);
  });
});

// A Lock Screen, Dynamic Island or Android notification Next / Previous lit the
// wall and opened or renewed the window natively while JS slept (2.7).
describe('DriveModeWatcher: a window opened from the Lock Screen', () => {
  function lockScreenWrite(snapshot: Partial<LiveActivityLightingWindowSnapshot>): void {
    lockScreen.snapshot = {
      sessionId: 'session-1',
      mode: 'window',
      endsAtMs: Date.now() + 30_000,
      windowSeconds: 45,
      family: 'general',
      source: 'lockScreen',
      updatedAtMs: Date.now() - 15_000,
      ...snapshot,
    };
  }

  function foreground(): void {
    act(() => {
      for (const listener of appState.listeners) listener('active');
    });
  }

  function navigate(): void {
    act(() => {
      for (const listener of lockScreen.navigateListeners) {
        listener({ action: 'next', currentIndex: 1, correlationId: 'corr-1' });
      }
    });
  }

  it('adopts it as a live window when the app comes back, ending where native said', () => {
    vi.useFakeTimers();
    mount();
    const endsAtMs = Date.now() + 30_000;
    lockScreenWrite({ endsAtMs });
    foreground();
    expect(getDriveMode()).toMatchObject({
      phase: 'live',
      startedBy: 'lock_screen',
      windowMs: 45_000,
      windowSetting: 'putOnBoardKeepsLighting',
      expiresAt: endsAtMs,
      sessionId: 'session-1',
      boardId: 7,
    });
    expect(effects.track).toHaveBeenCalledWith(
      'Drive Mode Started',
      expect.objectContaining({ startedBy: 'lock_screen', inSession: true }),
    );
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(getLastDriveModeExitReason()).toBe('window_ended');
  });

  it('takes the later end a press left before the catch-up can end the window as overdue', () => {
    vi.useFakeTimers();
    mount();
    act(() => {
      enterDriveMode({
        startedBy: 'tap',
        sessionId: 'session-1',
        boardId: 7,
        windowMs: 45_000,
        windowSetting: 'putOnBoardKeepsLighting',
      });
    });
    act(() => emitWallConfirm('climb-a'));
    // Suspended for a minute; a lock-screen Next 25 s ago renewed it.
    vi.setSystemTime(Date.now() + 60_000);
    lockScreenWrite({ endsAtMs: Date.now() + 20_000, updatedAtMs: Date.now() - 25_000 });
    foreground();
    expect(getDriveMode()).toMatchObject({ phase: 'live', startedBy: 'tap', expiresAt: Date.now() + 20_000 });
    expect(getDriveMode()?.windowRenewals).toBe(1);
  });

  it('checks for a renewal at the old end, before ending the window', () => {
    vi.useFakeTimers();
    mount();
    act(() => {
      enterDriveMode({
        startedBy: 'tap',
        sessionId: 'session-1',
        boardId: 7,
        windowMs: 45_000,
        windowSetting: 'putOnBoardKeepsLighting',
      });
    });
    act(() => emitWallConfirm('climb-a'));
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    // A notification Next renewed it natively; its event has not reached JS yet.
    lockScreenWrite({ endsAtMs: Date.now() + 45_000, updatedAtMs: Date.now() });
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(getDriveMode()?.phase).toBe('live');
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(getLastDriveModeExitReason()).toBe('window_ended');
  });

  it('starts an open-ended drive from nothing when the press drove the wall (Until I stop)', () => {
    mount();
    lockScreenWrite({ mode: 'driving', endsAtMs: null, windowSeconds: null, family: 'moonboard' });
    navigate();
    expect(getDriveMode()).toMatchObject({ phase: 'live', startedBy: 'lock_screen', windowMs: null, expiresAt: null });
  });

  it('turns a running window into a drive with no end when the press drove the wall (Until I stop)', () => {
    vi.useFakeTimers();
    mount();
    act(() => {
      enterDriveMode({
        startedBy: 'tap',
        sessionId: 'session-1',
        boardId: 7,
        windowMs: 45_000,
        windowSetting: 'putOnBoardKeepsLighting',
      });
    });
    act(() => emitWallConfirm('climb-a'));
    expect(getDriveMode()).toMatchObject({ phase: 'live', windowMs: 45_000 });
    lockScreenWrite({ mode: 'driving', endsAtMs: null, windowSeconds: null, family: 'general' });
    navigate();
    expect(getDriveMode()).toMatchObject({
      phase: 'live',
      startedBy: 'tap',
      windowMs: null,
      windowSetting: null,
      expiresAt: null,
    });
    // No end any more: the window's old end passes and the drive goes on.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(getDriveMode()?.phase).toBe('live');
  });

  it('waits for the link before adopting, then adopts once it is up', () => {
    reads.current = { ...reads.current, isConnected: false };
    const watcher = mount();
    lockScreenWrite({});
    foreground();
    expect(getDriveMode()).toBeNull();
    watcher.change({ isConnected: true });
    expect(getDriveMode()).toMatchObject({ phase: 'live', startedBy: 'lock_screen' });
  });

  it('adopts each press once: a stop in the app is not undone by the next foreground', () => {
    mount();
    lockScreenWrite({ mode: 'driving', endsAtMs: null, windowSeconds: null });
    foreground();
    expect(getDriveMode()?.startedBy).toBe('lock_screen');
    act(() => {
      stopDrivingForLink();
    });
    foreground();
    expect(getDriveMode()).toBeNull();
  });

  it('ignores a window written by the app itself, another session, or one already over', () => {
    mount();
    lockScreenWrite({ source: 'app' });
    foreground();
    lockScreenWrite({ sessionId: 'session-0', updatedAtMs: Date.now() - 1 });
    foreground();
    lockScreenWrite({ endsAtMs: Date.now() - 1, updatedAtMs: Date.now() - 2 });
    foreground();
    expect(getDriveMode()).toBeNull();
  });

  it('never adopts a press left by an earlier JS: a relaunch starts with nobody driving', () => {
    resetLockScreenLightingForTests({ startedAt: Date.now() });
    const watcher = mount();
    lockScreenWrite({ mode: 'driving', endsAtMs: null, windowSeconds: null, updatedAtMs: Date.now() - 60_000 });
    foreground();
    expect(getDriveMode()).toBeNull();
    navigate();
    expect(getDriveMode()).toBeNull();
    // Nor when the link comes back.
    watcher.change({ isConnected: false });
    watcher.change({ isConnected: true });
    expect(getDriveMode()).toBeNull();
    expect(effects.track).not.toHaveBeenCalledWith('Drive Mode Started', expect.anything());
  });
});

// An Android notification Previous / Next: the receiver only forwards the
// press, and JS lights the wall, so JS opens the window at the lit confirm.
describe('DriveModeWatcher: an Android notification press', () => {
  function navigate(currentIndex = 1): void {
    act(() => {
      for (const listener of lockScreen.navigateListeners) {
        listener({ action: 'next', currentIndex, correlationId: 'corr-1' });
      }
    });
  }

  beforeEach(() => {
    lockScreen.android = true;
    reads.current = { ...reads.current, boardName: 'kilter', lightOnSwipe: false, queueLength: 3 };
  });

  it('arms a window that starts at the wall’s lit confirm, then ends on time', () => {
    vi.useFakeTimers();
    mount();
    navigate();
    expect(getDriveMode()).toMatchObject({
      phase: 'arming',
      startedBy: 'lock_screen',
      windowMs: 45_000,
      windowSetting: 'putOnBoardKeepsLighting',
      expiresAt: null,
    });
    expect(effects.track).toHaveBeenCalledWith(
      'Drive Mode Started',
      expect.objectContaining({ startedBy: 'lock_screen', inSession: true }),
    );
    act(() => {
      vi.advanceTimersByTime(400);
    });
    act(() => emitWallConfirm('climb-b'));
    expect(getDriveMode()).toMatchObject({ phase: 'live', climbsLit: 1, expiresAt: Date.now() + 45_000 });
    act(() => {
      vi.advanceTimersByTime(45_000);
    });
    expect(getLastDriveModeExitReason()).toBe('window_ended');
  });

  it('never shows a window for a press that never lights: arming times out', () => {
    vi.useFakeTimers();
    mount();
    navigate();
    act(() => {
      vi.advanceTimersByTime(DRIVE_ARMING_TIMEOUT_MS);
    });
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('arming_timed_out');
  });

  it('arms an open-ended drive for Until I stop (the MoonBoard default)', () => {
    reads.current = { ...reads.current, boardName: 'moonboard' };
    mount();
    navigate();
    expect(getDriveMode()).toMatchObject({ phase: 'arming', startedBy: 'lock_screen', windowMs: null });
    act(() => emitWallConfirm('climb-b'));
    expect(getDriveMode()).toMatchObject({ phase: 'live', windowMs: null, expiresAt: null });
  });

  it('renews a running window at the confirm instead of arming another', () => {
    vi.useFakeTimers();
    mount();
    act(() => {
      enterDriveMode({
        startedBy: 'tap',
        sessionId: 'session-1',
        boardId: 7,
        windowMs: 45_000,
        windowSetting: 'putOnBoardKeepsLighting',
      });
    });
    act(() => emitWallConfirm('climb-a'));
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    navigate();
    expect(getDriveMode()).toMatchObject({ phase: 'live', startedBy: 'tap' });
    act(() => emitWallConfirm('climb-b'));
    expect(getDriveMode()).toMatchObject({ expiresAt: Date.now() + 45_000, windowRenewals: 1 });
  });

  it.each([
    ['without a link', { isConnected: false }],
    ['with Off', { keepLighting: 'off' }],
    ['with the swipe flag off', { swipeToDrive: false }],
    ['solo with Light the board as I swipe on', { lightOnSwipe: true }],
    ['in a crew with In a session too off', { isCrew: true, drivesInSession: false }],
  ] as const)('lights one climb %s', (_case, change) => {
    reads.current = { ...reads.current, ...change };
    mount();
    navigate();
    expect(getDriveMode()).toBeNull();
  });

  it('arms nothing for a press the queue cannot hold, which the bridge drops', () => {
    mount();
    navigate(3);
    navigate(-1);
    expect(getDriveMode()).toBeNull();
  });

  it('arms nothing on iOS, where the intent writes the window itself', () => {
    lockScreen.android = false;
    mount();
    navigate();
    expect(getDriveMode()).toBeNull();
  });
});
