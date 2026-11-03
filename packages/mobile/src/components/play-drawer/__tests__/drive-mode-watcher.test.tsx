// @vitest-environment jsdom
// #7113: the one owner that ends a drive, mounted once in the root layout. It
// reads the Bluetooth link, the session, the bound board and sign-in.
import { act, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LiveActivityLightingWindowSnapshot,
  LiveActivityLockScreenPress,
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
  /** Settings › Board's Always drive the wall. */
  alwaysDrive?: boolean;
  isCrew?: boolean;
  /** Settings › Board's keep-lighting (2.7). */
  keepLighting?: string;
  drivesInSession?: boolean;
  /** The swipe flag, keep-lighting's kill switch. */
  swipeToDrive?: boolean;
  /** The connected board's type. */
  boardName?: string;
  /** How many climbs the queue holds, for a notification press's index. */
  queueLength?: number;
  /** Disconnect Bluetooth when driving ends (2.7). */
  disconnectWhenDrivingEnds?: boolean;
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
  },
}));
const bluetoothDisconnect = vi.hoisted(() => vi.fn(async (_reason?: string) => undefined));
// Lighting the wall, which the watcher must never do itself: Light
// automatically's drive starts on whatever connecting already lit.
const bluetoothLight = vi.hoisted(() => vi.fn());
vi.mock('../../../providers/bluetooth-provider', () => ({
  useOptionalBluetoothContext: () => ({
    isConnected: reads.current.isConnected,
    virtualWallHeld: reads.current.virtualWallHeld,
    loading: reads.current.loading,
    boardName: reads.current.boardName ?? 'moonboard',
    disconnect: bluetoothDisconnect,
    reassertWall: bluetoothLight,
    turnOffAllLights: bluetoothLight,
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
  hapticWarning: vi.fn(),
  announceQueued: vi.fn(),
  track: vi.fn(),
}));
vi.mock('../../../lib/haptics', () => ({
  hapticLight: effects.hapticLight,
  hapticSuccess: effects.hapticSuccess,
  hapticWarning: effects.hapticWarning,
}));
// The board let go mid-drive (board plan item 8) reads who is signed in;
// `board-lets-go.test.tsx` covers what it says.
vi.mock('../../../hooks/use-viewer-user-id', () => ({ useViewerUserId: () => 'user-me' }));
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
      // The retired MoonBoard choice is not read: asking for it throws below.
      case 'putOnBoardDrivesInSession':
        return [reads.current.drivesInSession ?? true, vi.fn()];
      case 'disconnectWhenDrivingEnds':
        return [reads.current.disconnectWhenDrivingEnds ?? false, vi.fn()];
      case 'alwaysDrive':
        return [reads.current.alwaysDrive ?? false, vi.fn()];
      default:
        throw new Error(`unexpected setting ${key}`);
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
// The stored drive an iOS lock-screen press writes natively
// (2.7), the press's queueNavigate event, and which platform hears it.
const lockScreen = vi.hoisted(() => ({
  snapshot: null as LiveActivityLightingWindowSnapshot | null,
  /** The iOS intent's press stamp: in flight from before its board write until it settles. */
  press: null as LiveActivityLockScreenPress | null,
  navigateListeners: new Set<(event: WidgetQueueNavigateEvent) => void>(),
  /** The iOS Lock Screen bulb's stop event (`lockScreenDriveStop`). */
  stopListeners: new Set<() => void>(),
  android: false,
}));
vi.mock('../../../lib/live-activity/live-activity-plugin', () => ({
  readLiveActivityLightingWindow: () => lockScreen.snapshot,
  readLiveActivityLockScreenPress: () => lockScreen.press,
  addWidgetQueueNavigateListener: (listener: (event: WidgetQueueNavigateEvent) => void) => {
    lockScreen.navigateListeners.add(listener);
    return () => {
      lockScreen.navigateListeners.delete(listener);
    };
  },
  addLockScreenDriveStopListener: (listener: () => void) => {
    lockScreen.stopListeners.add(listener);
    return () => {
      lockScreen.stopListeners.delete(listener);
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
import { LOCK_SCREEN_PRESS_RECHECK_MS, resetLockScreenLightingForTests } from '../lock-screen-lighting';
import {
  DRIVE_ARMING_TIMEOUT_MS,
  clearDrivingStopped,
  drivingAtPick,
  enterDriveMode,
  exitDriveMode,
  getDriveMode,
  getLastDriveEnded,
  getLastDriveModeExitReason,
  isDrivingStoppedForLink,
  markDriveLive,
  resetDriveModeForTests,
  stopDrivingForLink,
  type DriveModeExitReason,
} from '../drive-mode-store';
import { CREW_PUT_UP_DISCONNECT_WAIT_MS } from '../use-drive-follow';

const DEFAULT_READS: Reads = {
  currentClimbQueueItem: null,
  isConnected: true,
  virtualWallHeld: false,
  loading: false,
  sessionId: 'session-1',
  boardId: 7,
  isAuthenticated: true,
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
  lockScreen.press = null;
  lockScreen.android = false;
  resetLockScreenLightingForTests();
  clearRelayReceipt();
  clearCrewPutUp();
  for (const effect of Object.values(effects)) effect.mockClear();
  bluetoothDisconnect.mockClear();
  bluetoothLight.mockClear();
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

  // Put on board with no remembered board opens the device picker, and the
  // climber may read the list for longer than the arming timeout.
  it('holds the arming clock while the connect is in flight, then starts it over', () => {
    vi.useFakeTimers();
    reads.current = { ...reads.current, isConnected: false, boardId: null };
    const watcher = mount();
    act(() =>
      enterDriveMode({
        startedBy: 'tap',
        sessionId: 'session-1',
        boardId: null,
        windowMs: 45_000,
        windowSetting: 'putOnBoardKeepsLighting',
      }),
    );
    watcher.change({ loading: true });
    act(() => {
      vi.advanceTimersByTime(DRIVE_ARMING_TIMEOUT_MS * 2);
    });
    expect(getDriveMode()?.phase).toBe('arming');
    // A board picked at last: the link is up and the climb is on its way.
    watcher.change({ loading: false, isConnected: true, boardId: 7 });
    act(() => {
      vi.advanceTimersByTime(DRIVE_ARMING_TIMEOUT_MS - 1);
    });
    expect(getDriveMode()?.phase).toBe('arming');
    act(() => emitWallConfirm('climb-a', 'self'));
    expect(getDriveMode()).toMatchObject({ phase: 'live', windowMs: 45_000 });
  });

  it('still gives up 30 s after a connect settles without lighting anything', () => {
    vi.useFakeTimers();
    reads.current = { ...reads.current, isConnected: false, boardId: null };
    const watcher = mount();
    act(() => enterDriveMode({ startedBy: 'swipe', sessionId: 'session-1', boardId: null }));
    watcher.change({ loading: true });
    act(() => {
      vi.advanceTimersByTime(DRIVE_ARMING_TIMEOUT_MS);
    });
    watcher.change({ loading: false, isConnected: true, boardId: 7 });
    act(() => {
      vi.advanceTimersByTime(DRIVE_ARMING_TIMEOUT_MS);
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
    act(() => emitWallConfirm('climb-a', 'self'));
    expect(getDriveMode()).toMatchObject({ phase: 'live', climbsLit: 1 });
    expect(effects.hapticSuccess).toHaveBeenCalledOnce();
  });

  it('never goes live on a confirm without this phone’s link', () => {
    reads.current = { ...reads.current, isConnected: false };
    mount();
    act(() => enterDriveMode({ startedBy: 'swipe', sessionId: 'session-1', boardId: 7 }));
    act(() => emitWallConfirm('climb-a', 'self'));
    expect(getDriveMode()).toMatchObject({ phase: 'arming', climbsLit: 0 });
  });

  // A crewmate lights their own wall in the same session, and the feed relays
  // their confirm here while this phone's swipe is still on its way.
  it('never goes live on a relayed confirm; this phone’s own confirm of the same climb still counts', () => {
    mount();
    act(() => enterDriveMode({ startedBy: 'swipe', sessionId: 'session-1', boardId: 7 }));
    act(() => emitWallConfirm('climb-a', 'relay'));
    expect(getDriveMode()).toMatchObject({ phase: 'arming', climbsLit: 0 });
    expect(effects.hapticSuccess).not.toHaveBeenCalled();
    act(() => emitWallConfirm('climb-a', 'self'));
    expect(getDriveMode()).toMatchObject({ phase: 'live', climbsLit: 1 });
    expect(effects.hapticSuccess).toHaveBeenCalledOnce();
  });

  it('counts each new climb lit once, the swipe’s own first; re-sends and echoes are not new', () => {
    mount();
    act(() => enterDriveMode({ startedBy: 'swipe', sessionId: 'session-1', boardId: 7 }));
    act(() => {
      emitWallConfirm('climb-a', 'self');
      // The crew feed's echo of the same write.
      emitWallConfirm('climb-a', 'relay');
      emitWallConfirm('climb-b', 'self');
      // A late echo of climb-a, landing after the drive moved on.
      emitWallConfirm('climb-a', 'relay');
      emitWallConfirm('climb-c', 'self');
      emitWallConfirm('climb-c', 'self');
    });
    expect(getDriveMode()?.climbsLit).toBe(3);
    // Prev back to a climb lit before is lit again.
    act(() => emitWallConfirm('climb-b', 'self'));
    expect(getDriveMode()?.climbsLit).toBe(4);
  });

  it('counts nothing with nobody driving, and starts over for a new drive', () => {
    mount();
    act(() => emitWallConfirm('climb-a', 'self'));
    act(() => {
      enterDriveMode({ startedBy: 'swipe', sessionId: 'session-1', boardId: 7, now: 1 });
      emitWallConfirm('climb-a', 'self');
      exitDriveMode('link_dropped');
      enterDriveMode({ startedBy: 'swipe', sessionId: 'session-1', boardId: 7, now: 2 });
      emitWallConfirm('climb-a', 'self');
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

// Always drive the wall (2026-11): an open-ended drive whenever this phone's own
// link holds the board. One switch, no other interaction mode: every pick
// lights the way a swipe drive's does.
describe('DriveModeWatcher: Always drive the wall', () => {
  beforeEach(() => {
    reads.current = { ...DEFAULT_READS, alwaysDrive: true, boardName: 'kilter' };
  });

  it('drives the moment it mounts on a link that is up, live, open-ended, lighting nothing itself', () => {
    mount();
    expect(getDriveMode()).toMatchObject({
      phase: 'live',
      startedBy: 'always',
      sessionId: 'session-1',
      boardId: 7,
      boardType: 'kilter',
      windowMs: null,
      expiresAt: null,
      climbsLit: 0,
    });
    expect(effects.track).toHaveBeenCalledWith('Drive Mode Started', {
      startedBy: 'always',
      inSession: true,
      boardType: 'kilter',
    });
    expect(bluetoothLight).not.toHaveBeenCalled();
  });

  it('starts when this phone’s link comes up, and ends when it drops', () => {
    reads.current = { ...reads.current, isConnected: false };
    const watcher = mount();
    expect(getDriveMode()).toBeNull();
    watcher.change({ isConnected: true });
    expect(getDriveMode()).toMatchObject({ phase: 'live', startedBy: 'always' });
    watcher.change({ isConnected: false });
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('link_dropped');
    watcher.change({ isConnected: true });
    expect(getDriveMode()).toMatchObject({ phase: 'live', startedBy: 'always' });
  });

  it('never drives without this phone’s own link: a crewmate’s board, or a wall with no lights', () => {
    reads.current = { ...reads.current, isConnected: false };
    const watcher = mount();
    expect(getDriveMode()).toBeNull();
    watcher.change({ virtualWallHeld: true });
    expect(getDriveMode()).toBeNull();
  });

  it('starts when the switch turns on with the link up, and lights nothing then either', () => {
    reads.current = { ...reads.current, alwaysDrive: false };
    const watcher = mount();
    expect(getDriveMode()).toBeNull();
    watcher.change({ alwaysDrive: true });
    expect(getDriveMode()).toMatchObject({ phase: 'live', startedBy: 'always' });
    expect(bluetoothLight).not.toHaveBeenCalled();
  });

  it('every climb that lights counts as one more, as in any drive', () => {
    mount();
    act(() => emitWallConfirm('climb-a', 'self'));
    act(() => emitWallConfirm('climb-b', 'self'));
    expect(getDriveMode()?.climbsLit).toBe(2);
  });

  it('turning the switch off ends its drive and keeps the link, whatever Disconnect says', () => {
    reads.current = { ...reads.current, disconnectWhenDrivingEnds: true };
    const watcher = mount();
    expect(getDriveMode()?.startedBy).toBe('always');
    watcher.change({ alwaysDrive: false });
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('always_off');
    expect(isDrivingStoppedForLink()).toBe(false);
    expect(bluetoothDisconnect).not.toHaveBeenCalled();
    // Off, nothing starts it again.
    watcher.change({ boardId: 7 });
    expect(getDriveMode()).toBeNull();
  });

  it('turning the switch off leaves a drive a swipe started', () => {
    reads.current = { ...reads.current, alwaysDrive: false };
    const watcher = mount();
    driveLive();
    watcher.change({ alwaysDrive: true });
    expect(getDriveMode()?.startedBy).toBe('swipe');
    watcher.change({ alwaysDrive: false });
    expect(getDriveMode()).toMatchObject({ phase: 'live', startedBy: 'swipe' });
  });

  it('a tap on You are driving the wall holds it stopped until the link drops', () => {
    const watcher = mount();
    act(() => {
      stopDrivingForLink();
    });
    watcher.change({});
    watcher.change({ boardId: 7 });
    expect(getDriveMode()).toBeNull();
    expect(isDrivingStoppedForLink()).toBe(true);
    // The switch never flips by itself.
    expect(reads.current.alwaysDrive).toBe(true);
    watcher.change({ isConnected: false });
    expect(isDrivingStoppedForLink()).toBe(false);
    expect(getDriveMode()).toBeNull();
    watcher.change({ isConnected: true });
    expect(getDriveMode()).toMatchObject({ phase: 'live', startedBy: 'always' });
  });

  // A flip of the switch is a fresh choice: the stop made before it goes.
  it('turning the switch off and on again after a stop drives again', () => {
    const watcher = mount();
    act(() => {
      stopDrivingForLink();
    });
    watcher.change({});
    expect(getDriveMode()).toBeNull();
    watcher.change({ alwaysDrive: false });
    expect(getDriveMode()).toBeNull();
    watcher.change({ alwaysDrive: true });
    expect(getDriveMode()).toMatchObject({ phase: 'live', startedBy: 'always' });
  });

  // The wall control's `tapDrive: 'resume'` drops the stop at the press.
  it('Put on board after a stop resumes it, open-ended', () => {
    const watcher = mount();
    act(() => {
      stopDrivingForLink();
    });
    watcher.change({});
    expect(getDriveMode()).toBeNull();
    act(() => {
      clearDrivingStopped();
    });
    expect(getDriveMode()).toMatchObject({ phase: 'live', startedBy: 'always', windowMs: null });
  });

  it('a tapped stop lets go of the board with Disconnect Bluetooth when driving ends on', () => {
    reads.current = { ...reads.current, disconnectWhenDrivingEnds: true };
    mount();
    act(() => {
      stopDrivingForLink();
    });
    expect(bluetoothDisconnect).toHaveBeenCalledExactlyOnceWith('driving_ended');
  });

  it('drives again in the new session once a change of session ended it, the link still up', () => {
    const watcher = mount();
    watcher.change({ sessionId: 'session-2' });
    expect(getDriveMode()).toMatchObject({ phase: 'live', startedBy: 'always', sessionId: 'session-2' });
  });

  it('opens up a timed drive already running when the switch turns on', () => {
    reads.current = { ...reads.current, alwaysDrive: false };
    const watcher = mount();
    act(() => {
      enterDriveMode({
        startedBy: 'tap',
        sessionId: 'session-1',
        boardId: 7,
        windowMs: 45_000,
        windowSetting: 'putOnBoardKeepsLighting',
      });
      markDriveLive();
    });
    watcher.change({});
    expect(getDriveMode()?.windowMs).toBe(45_000);
    watcher.change({ alwaysDrive: true });
    expect(getDriveMode()).toMatchObject({
      phase: 'live',
      startedBy: 'tap',
      windowMs: null,
      expiresAt: null,
      openedByAlways: true,
    });
  });

  // The climber's 45 s window went when the switch opened it up: turning the
  // switch off again ends it rather than leaving a drive with no end.
  it('ends a timed drive it opened up when the switch goes off again, keeping the link', () => {
    reads.current = { ...reads.current, alwaysDrive: false, disconnectWhenDrivingEnds: true };
    const watcher = mount();
    act(() => {
      enterDriveMode({
        startedBy: 'tap',
        sessionId: 'session-1',
        boardId: 7,
        windowMs: 45_000,
        windowSetting: 'putOnBoardKeepsLighting',
      });
      markDriveLive();
    });
    watcher.change({ alwaysDrive: true });
    expect(getDriveMode()?.openedByAlways).toBe(true);
    watcher.change({ alwaysDrive: false });
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('always_off');
    expect(bluetoothDisconnect).not.toHaveBeenCalled();
  });

  // Driving's kill switch: Always drive the wall's drive is a drive like any other.
  it('starts nothing with the swipe flag off, and ends its drive keeping the link when the flag goes off', () => {
    reads.current = { ...reads.current, swipeToDrive: false };
    const watcher = mount();
    expect(getDriveMode()).toBeNull();
    watcher.change({ swipeToDrive: true });
    expect(getDriveMode()).toMatchObject({ phase: 'live', startedBy: 'always' });
    watcher.change({ swipeToDrive: false });
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('always_off');
    expect(bluetoothDisconnect).not.toHaveBeenCalled();
  });

  // Signing out drops no link, and Always drive the wall drives signed out too
  // (as the switches it replaced lit): one drive ends, the next starts at once.
  it('drives on after a sign-out with the link still up, as a new drive', () => {
    const watcher = mount();
    expect(getDriveMode()?.startedBy).toBe('always');
    effects.track.mockClear();
    watcher.change({ isAuthenticated: false });
    expect(effects.track).toHaveBeenCalledWith(
      'Drive Mode Ended',
      expect.objectContaining({ reason: 'signed_out', startedBy: 'always' }),
    );
    expect(getDriveMode()).toMatchObject({ phase: 'live', startedBy: 'always' });
  });

  describe('in a crew', () => {
    it('drives with In a session too on', () => {
      reads.current = { ...reads.current, isCrew: true, drivesInSession: true };
      mount();
      expect(getDriveMode()).toMatchObject({ phase: 'live', startedBy: 'always' });
    });

    it('leaves picks previews with In a session too off', () => {
      reads.current = { ...reads.current, isCrew: true, drivesInSession: false };
      mount();
      expect(getDriveMode()).toBeNull();
    });

    // A MoonBoard follows In a session too like every board.
    it("leaves a MoonBoard's picks previews with In a session too off", () => {
      reads.current = { ...reads.current, isCrew: true, drivesInSession: false, boardName: 'moonboard' };
      mount();
      expect(getDriveMode()).toBeNull();
    });

    it('drives a MoonBoard with In a session too on', () => {
      reads.current = { ...reads.current, isCrew: true, drivesInSession: true, boardName: 'moonboard' };
      mount();
      expect(getDriveMode()).toMatchObject({ phase: 'live', startedBy: 'always', boardType: 'moonboard' });
    });

    it('goes on when a crew forms with In a session too on', () => {
      reads.current = { ...reads.current, drivesInSession: true };
      const watcher = mount();
      const startedAt = getDriveMode()?.startedAt;
      watcher.change({ isCrew: true });
      expect(getDriveMode()).toMatchObject({ phase: 'live', startedBy: 'always', startedAt });
    });

    it('ends keeping the link when a crew forms with In a session too off, and comes back when it leaves', () => {
      reads.current = { ...reads.current, drivesInSession: false, disconnectWhenDrivingEnds: true };
      const watcher = mount();
      expect(getDriveMode()?.startedBy).toBe('always');
      watcher.change({ isCrew: true });
      expect(getDriveMode()).toBeNull();
      expect(getLastDriveModeExitReason()).toBe('always_off');
      expect(bluetoothDisconnect).not.toHaveBeenCalled();
      watcher.change({ isCrew: false });
      expect(getDriveMode()).toMatchObject({ phase: 'live', startedBy: 'always' });
    });

    it('In a session too turned off in a crew ends it the same way', () => {
      reads.current = { ...reads.current, isCrew: true, drivesInSession: true };
      const watcher = mount();
      expect(getDriveMode()?.startedBy).toBe('always');
      watcher.change({ drivesInSession: false });
      expect(getDriveMode()).toBeNull();
      expect(getLastDriveModeExitReason()).toBe('always_off');
    });
  });
});

// Put on board's timed drive (2.7, Stop driving after): one timeout to its end, re-keyed by
// each renewal, a catch-up on the foreground, and its setting turned off.
describe('DriveModeWatcher: the timed drive', () => {
  function openWindow(windowMs = 45_000) {
    act(() => {
      enterDriveMode({
        startedBy: 'tap',
        sessionId: reads.current.sessionId,
        boardId: reads.current.boardId,
        boardType: reads.current.boardName ?? 'moonboard',
        windowMs,
        windowSetting: 'putOnBoardKeepsLighting',
      });
    });
  }

  it('ends the window at its end, and not a moment before', () => {
    vi.useFakeTimers();
    mount();
    openWindow();
    act(() => emitWallConfirm('climb-a', 'self'));
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
    act(() => emitWallConfirm('climb-a', 'self'));
    act(() => {
      vi.advanceTimersByTime(40_000);
    });
    act(() => emitWallConfirm('climb-b', 'self'));
    act(() => {
      vi.advanceTimersByTime(40_000);
    });
    expect(getDriveMode()).toMatchObject({ phase: 'live', climbsLit: 2, windowRenewals: 1 });
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(getLastDriveModeExitReason()).toBe('window_ended');
  });

  // A crewmate's confirm from another wall, relayed by the session feed.
  it('never starts or renews the clock on a relayed confirm', () => {
    vi.useFakeTimers();
    mount();
    openWindow();
    act(() => emitWallConfirm('climb-elsewhere', 'relay'));
    expect(getDriveMode()).toMatchObject({ phase: 'arming', expiresAt: null });
    act(() => emitWallConfirm('climb-a', 'self'));
    const endsAt = Date.now() + 45_000;
    expect(getDriveMode()).toMatchObject({ phase: 'live', climbsLit: 1, expiresAt: endsAt });
    act(() => {
      vi.advanceTimersByTime(40_000);
    });
    act(() => emitWallConfirm('climb-b', 'relay'));
    expect(getDriveMode()).toMatchObject({ phase: 'live', climbsLit: 1, windowRenewals: 0, expiresAt: endsAt });
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(getLastDriveModeExitReason()).toBe('window_ended');
  });

  it('waits out the rest when its timer fires early', () => {
    vi.useFakeTimers();
    mount();
    openWindow();
    act(() => emitWallConfirm('climb-a', 'self'));
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

  // #7038: Android pauses JS timers with the activity, so a pick can come
  // after the window's end with this timer not yet fired. The pick reads the
  // clock and lights nothing; the watcher tidies once its timer runs.
  it('lets a pick past the end light nothing while its timer is held, then tidies', () => {
    vi.useFakeTimers();
    mount();
    openWindow();
    act(() => emitWallConfirm('climb-a', 'self'));
    // The clock moves past the end; no timer runs.
    vi.setSystemTime(Date.now() + 46_000);
    expect(drivingAtPick(getDriveMode()?.phase === 'live')).toBe(false);
    expect(getDriveMode()?.phase).toBe('live');
    // The activity resumes and the held timer runs.
    act(() => {
      vi.advanceTimersByTime(45_000);
    });
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('window_ended');
  });

  it('catches up the moment the app comes back after its end passed in the background', () => {
    vi.useFakeTimers();
    mount();
    openWindow();
    act(() => emitWallConfirm('climb-a', 'self'));
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
    act(() => emitWallConfirm('climb-a', 'self'));
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
    act(() => emitWallConfirm('climb-a', 'self'));
    watcher.change({ keepLighting: '30' });
    expect(getDriveMode()?.phase).toBe('live');
    watcher.change({ keepLighting: 'off' });
    expect(getLastDriveModeExitReason()).toBe('window_ended');
  });

  // The board sheet's Keep lighting row at the wall (spec B4, WCAG 2.2.1): a
  // new length applies to the running window, counted from the change.
  it('takes a new length picked mid-window, counted from the change', () => {
    vi.useFakeTimers();
    const watcher = mount();
    openWindow();
    act(() => emitWallConfirm('climb-a', 'self'));
    act(() => {
      vi.advanceTimersByTime(25_000);
    });
    watcher.change({ keepLighting: '60' });
    expect(getDriveMode()).toMatchObject({ phase: 'live', windowMs: 60_000 });
    // Past the old 45 s end, still lighting.
    act(() => {
      vi.advanceTimersByTime(60_000 - 1);
    });
    expect(getDriveMode()?.phase).toBe('live');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(getLastDriveModeExitReason()).toBe('window_ended');
  });

  it('turns the window open-ended when Until I stop is picked mid-window', () => {
    vi.useFakeTimers();
    const watcher = mount();
    openWindow();
    act(() => emitWallConfirm('climb-a', 'self'));
    watcher.change({ keepLighting: 'until_stopped' });
    expect(getDriveMode()).toMatchObject({ phase: 'live', windowMs: null, expiresAt: null });
    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    expect(getDriveMode()?.phase).toBe('live');
  });

  // Stop driving after is one choice for every board: a MoonBoard's timed
  // drive takes its new length too.
  it("gives a MoonBoard's timed drive the new Stop driving after length", () => {
    reads.current = { ...reads.current, boardName: 'moonboard' };
    const watcher = mount();
    openWindow();
    act(() => emitWallConfirm('climb-a', 'self'));
    watcher.change({ keepLighting: '30' });
    expect(getDriveMode()).toMatchObject({ phase: 'live', windowMs: 30_000 });
  });

  it('ends the window in a crew when In a session too is turned off, and not solo', () => {
    const watcher = mount();
    openWindow();
    act(() => emitWallConfirm('climb-a', 'self'));
    watcher.change({ drivesInSession: false });
    expect(getDriveMode()?.phase).toBe('live');
    watcher.change({ isCrew: true });
    expect(getLastDriveModeExitReason()).toBe('window_ended');
  });

  // The window lights this phone's own picks (2.7): a crewmate's put-up takes
  // the wall back, so the holder's next pick is a preview again and Put on
  // board asks the busy-wall question. Their relay never renews the window.
  it('ends the window when a crewmate puts a climb up; their relay never renews it', () => {
    vi.useFakeTimers();
    reads.current = { ...reads.current, isCrew: true, currentClimbQueueItem: queueItem('q-1', 'Mine') };
    const watcher = mount();
    openWindow();
    act(() => emitWallConfirm('climb-q-1', 'self'));
    act(() => {
      vi.advanceTimersByTime(40_000);
    });
    act(() => crewMove('q-2'));
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('window_ended');
    // This phone's auto-sender lights the crewmate's climb: no drive to renew.
    watcher.change({ currentClimbQueueItem: queueItem('q-2', 'Crimp Ladder') });
    act(() => emitWallConfirm('climb-q-2', 'self'));
    expect(getDriveMode()).toBeNull();
    expect(getCrewPutUp()).toBeNull();
  });

  // The window can stay arming for as long as the device picker is open. A
  // crewmate's put-up then ends it too: left arming, the crewmate's climb
  // lighting here would take it live, and the holder's next pick would take
  // the wall back from them without the busy-wall question.
  it('ends a window still arming when a crewmate puts a climb up; their lit climb never starts it', () => {
    reads.current = { ...reads.current, isCrew: true, currentClimbQueueItem: queueItem('q-1', 'Mine') };
    const watcher = mount();
    openWindow();
    expect(getDriveMode()).toMatchObject({ phase: 'arming', windowMs: 45_000 });
    act(() => crewMove('q-2'));
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('window_ended');
    watcher.change({ currentClimbQueueItem: queueItem('q-2', 'Crimp Ladder') });
    act(() => emitWallConfirm('climb-q-2', 'self'));
    expect(getDriveMode()).toBeNull();
  });

  // The climber's own Lock Screen Next or watch step: the server names their
  // account as the mover, so it is their step, never a crewmate's put-up.
  it("keeps the window through the climber's own Lock Screen step", () => {
    reads.current = { ...reads.current, isCrew: true, currentClimbQueueItem: queueItem('q-1', 'Mine') };
    mount();
    openWindow();
    act(() => emitWallConfirm('climb-q-1', 'self'));
    act(() =>
      noteRelayReceipt({
        eventType: 'CurrentClimbChanged',
        incomingQueueItemUuid: 'q-2',
        localQueueItemUuid: 'q-1',
        correlationId: 'widget-navigate',
        currentChangedBy: 'participant-me',
        participantId: 'participant-me',
      }),
    );
    expect(getDriveMode()).toMatchObject({ phase: 'live', windowMs: 45_000 });
  });

  it("keeps the window through this phone's own move and its echo", () => {
    reads.current = { ...reads.current, isCrew: true, currentClimbQueueItem: queueItem('q-1', 'Mine') };
    mount();
    openWindow();
    act(() => emitWallConfirm('climb-q-1', 'self'));
    noteOwnMove('q-own');
    act(() => crewMove('q-own'));
    expect(getDriveMode()).toMatchObject({ phase: 'live', windowMs: 45_000 });
  });

  // In a session too is one rule for every board: a MoonBoard's timed drive
  // ends keeping the link once a crew forms with it off.
  it("ends a MoonBoard's timed drive when a crew forms with In a session too off", () => {
    reads.current = { ...reads.current, boardName: 'moonboard', drivesInSession: false };
    const watcher = mount();
    openWindow(30_000);
    act(() => emitWallConfirm('climb-a', 'self'));
    expect(getDriveMode()).toMatchObject({ phase: 'live', boardType: 'moonboard' });
    watcher.change({ isCrew: true });
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('window_ended');
    expect(getLastDriveEnded()).toMatchObject({ reason: 'window_ended', keepLink: true });
  });

  it('drops its timer once the window ends another way', () => {
    vi.useFakeTimers();
    const watcher = mount();
    // The lock-screen adoption listens for the foreground all the time.
    const alwaysListening = appState.listeners.size;
    openWindow();
    act(() => emitWallConfirm('climb-a', 'self'));
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
describe('DriveModeWatcher: a timed drive started from the Lock Screen', () => {
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
    act(() => emitWallConfirm('climb-a', 'self'));
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
    act(() => emitWallConfirm('climb-a', 'self'));
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

  // A pick reads the window's end off the wall clock (#7038). A press after
  // the end opened a new window natively; the old one ended at its end.
  it('ends a window that ran out before the press, and starts the press’s own', () => {
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
    act(() => emitWallConfirm('climb-a', 'self'));
    // Suspended for a minute; a lock-screen Next 10 s ago, after the end.
    vi.setSystemTime(Date.now() + 60_000);
    lockScreenWrite({ endsAtMs: Date.now() + 35_000, updatedAtMs: Date.now() - 10_000 });
    foreground();
    expect(effects.track).toHaveBeenCalledWith(
      'Drive Mode Ended',
      // Its 45 s, not the minute until the app came back.
      expect.objectContaining({ reason: 'window_ended', startedBy: 'tap', durationSec: 45 }),
    );
    expect(getDriveMode()).toMatchObject({
      phase: 'live',
      startedBy: 'lock_screen',
      expiresAt: Date.now() + 35_000,
      windowRenewals: 0,
    });
  });

  // A crewmate's put-up ends Put on board's window, and one a press opened
  // while JS slept is this phone's window too: adopted, then ended, so the
  // next foreground can't bring it back.
  it('ends a window a press opened that the app had not adopted when a crewmate puts a climb up', () => {
    reads.current = { ...reads.current, isCrew: true, currentClimbQueueItem: queueItem('q-1', 'Mine') };
    mount();
    lockScreenWrite({});
    act(() => crewMove('q-2'));
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('window_ended');
    expect(effects.track).toHaveBeenCalledWith(
      'Drive Mode Ended',
      expect.objectContaining({ reason: 'window_ended', startedBy: 'lock_screen' }),
    );
    foreground();
    expect(getDriveMode()).toBeNull();
  });

  it('starts an open-ended drive from nothing when the press drove the wall (Until I stop)', () => {
    mount();
    lockScreenWrite({ mode: 'driving', endsAtMs: null, windowSeconds: null, family: 'general' });
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
    act(() => emitWallConfirm('climb-a', 'self'));
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

// The iOS Lock Screen / Dynamic Island bulb while this phone drives: native
// stores the stop (StopDrivingIntent) and JS stops the drive the way the
// frosted button does.
describe('DriveModeWatcher: a stop from the Lock Screen bulb', () => {
  function lockScreenStop(updatedAtMs = Date.now()): void {
    lockScreen.snapshot = { sessionId: 'session-1', mode: 'off', source: 'lockScreen', updatedAtMs };
  }

  function stopEvent(): void {
    act(() => {
      for (const listener of lockScreen.stopListeners) listener();
    });
  }

  function foreground(): void {
    act(() => {
      for (const listener of appState.listeners) listener('active');
    });
  }

  it('stops a live drive on the stop event, keeping the link like the frosted button', () => {
    vi.useFakeTimers();
    mount();
    driveLive();
    vi.setSystemTime(Date.now() + 5_000);
    lockScreenStop();
    stopEvent();
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('stopped');
    expect(isDrivingStoppedForLink()).toBe(true);
    expect(effects.track).toHaveBeenCalledWith(
      'Drive Mode Ended',
      expect.objectContaining({ reason: 'stopped', startedBy: 'swipe' }),
    );
    expect(bluetoothDisconnect).not.toHaveBeenCalled();
  });

  it('stops a timed drive when the app comes back after a tap it slept through', () => {
    vi.useFakeTimers();
    const watcher = mount();
    act(() => {
      enterDriveMode({
        startedBy: 'tap',
        sessionId: 'session-1',
        boardId: 7,
        windowMs: 45_000,
        windowSetting: 'putOnBoardKeepsLighting',
      });
    });
    act(() => emitWallConfirm('climb-a', 'self'));
    vi.setSystemTime(Date.now() + 10_000);
    // Tapped while JS slept: no event reached it.
    lockScreenStop();
    vi.setSystemTime(Date.now() + 5_000);
    foreground();
    expect(getLastDriveModeExitReason()).toBe('stopped');
    expect(getDriveMode()).toBeNull();
    // Adopted once: a drive started since survives the next foreground.
    watcher.change({ isConnected: false });
    watcher.change({ isConnected: true });
    driveLive();
    foreground();
    expect(getDriveMode()?.phase).toBe('live');
  });

  it('never stops a drive that started after the tap', () => {
    vi.useFakeTimers();
    mount();
    lockScreenStop(Date.now() - 1_000);
    driveLive();
    stopEvent();
    foreground();
    expect(getDriveMode()).toMatchObject({ phase: 'live', startedBy: 'swipe' });
  });

  it('ignores another session’s stop', () => {
    mount();
    driveLive();
    lockScreen.snapshot = { sessionId: 'session-0', mode: 'off', source: 'lockScreen', updatedAtMs: Date.now() + 1 };
    stopEvent();
    expect(getDriveMode()?.phase).toBe('live');
  });

  it('frees the board without forgetting it when Disconnect Bluetooth when driving ends is on', async () => {
    vi.useFakeTimers();
    reads.current = { ...reads.current, disconnectWhenDrivingEnds: true };
    mount();
    driveLive();
    vi.setSystemTime(Date.now() + 5_000);
    lockScreenStop();
    await act(async () => {
      for (const listener of lockScreen.stopListeners) listener();
      await Promise.resolve();
    });
    expect(bluetoothDisconnect).toHaveBeenCalledExactlyOnceWith('driving_ended');
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
    reads.current = { ...reads.current, boardName: 'kilter', queueLength: 3 };
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
    act(() => emitWallConfirm('climb-b', 'self'));
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

  it('arms an open-ended drive for Until I stop', () => {
    reads.current = { ...reads.current, keepLighting: 'until_stopped' };
    mount();
    navigate();
    expect(getDriveMode()).toMatchObject({ phase: 'arming', startedBy: 'lock_screen', windowMs: null });
    act(() => emitWallConfirm('climb-b', 'self'));
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
    act(() => emitWallConfirm('climb-a', 'self'));
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    navigate();
    expect(getDriveMode()).toMatchObject({ phase: 'live', startedBy: 'tap' });
    act(() => emitWallConfirm('climb-b', 'self'));
    expect(getDriveMode()).toMatchObject({ expiresAt: Date.now() + 45_000, windowRenewals: 1 });
  });

  // Android pauses JS timers with the activity (#7038): the window's end
  // passed with its timer held. The press reads the end itself, so the old
  // window ends there and the press's confirm starts a window of its own.
  it('ends a window past its end at the press, and the confirm starts the press’s own', () => {
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
    act(() => emitWallConfirm('climb-a', 'self'));
    vi.setSystemTime(Date.now() + 60_000);
    navigate();
    expect(effects.track).toHaveBeenCalledWith(
      'Drive Mode Ended',
      expect.objectContaining({ reason: 'window_ended', startedBy: 'tap', durationSec: 45 }),
    );
    expect(getDriveMode()).toMatchObject({ phase: 'arming', startedBy: 'lock_screen' });
    act(() => emitWallConfirm('climb-b', 'self'));
    expect(getDriveMode()).toMatchObject({
      phase: 'live',
      startedBy: 'lock_screen',
      expiresAt: Date.now() + 45_000,
      windowRenewals: 0,
    });
  });

  it.each([
    ['without a link', { isConnected: false }],
    ['with Off', { keepLighting: 'off' }],
    ['with the swipe flag off', { swipeToDrive: false }],
    ['in a crew with In a session too off', { isCrew: true, drivesInSession: false }],
  ] as const)('lights one climb %s', (_case, change) => {
    reads.current = { ...reads.current, ...change };
    mount();
    navigate();
    expect(getDriveMode()).toBeNull();
  });

  // Where Always drive the wall drives, a press after a stop lights its climb and
  // starts nothing: only Put on board resumes the drive.
  it('lights one climb where Always drive the wall drives, a stop holding its drive off', () => {
    act(() => {
      stopDrivingForLink();
    });
    reads.current = { ...reads.current, alwaysDrive: true };
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

// 2.7: auto-disconnect gave way to Disconnect Bluetooth when driving ends. The
// ends the climber or the clock caused let go of the board, without forgetting
// it (`driving_ended`), so the next Put on board reconnects. The ends that
// already deal with the link, or move this phone elsewhere, never do.
describe('DriveModeWatcher: Disconnect Bluetooth when driving ends', () => {
  function openTimedDrive() {
    act(() => {
      enterDriveMode({
        startedBy: 'tap',
        sessionId: reads.current.sessionId,
        boardId: reads.current.boardId,
        windowMs: 45_000,
        windowSetting: 'putOnBoardKeepsLighting',
      });
    });
    act(() => emitWallConfirm('climb-a', 'self'));
  }

  it('lets go when the time runs out, and only then', () => {
    vi.useFakeTimers();
    reads.current = { ...reads.current, disconnectWhenDrivingEnds: true };
    mount();
    openTimedDrive();
    act(() => {
      vi.advanceTimersByTime(45_000 - 1);
    });
    expect(bluetoothDisconnect).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(getLastDriveModeExitReason()).toBe('window_ended');
    expect(bluetoothDisconnect).toHaveBeenCalledExactlyOnceWith('driving_ended');
  });

  // A MoonBoard is no exception: the switch frees it like every board, so a
  // climber who wants to keep the MoonBoard's link leaves the switch off.
  it.each([
    ['its time runs out', 'window_ended'],
    ['the climber stops it', 'stopped'],
  ] as const)('lets go of a MoonBoard when %s, like every board', (_case, reason) => {
    vi.useFakeTimers();
    reads.current = { ...reads.current, disconnectWhenDrivingEnds: true, boardName: 'moonboard' };
    mount();
    act(() => {
      enterDriveMode({
        startedBy: 'tap',
        sessionId: reads.current.sessionId,
        boardId: reads.current.boardId,
        boardType: 'moonboard',
        windowMs: 45_000,
        windowSetting: 'putOnBoardKeepsLighting',
      });
    });
    act(() => emitWallConfirm('climb-a', 'self'));
    if (reason === 'window_ended') {
      act(() => {
        vi.advanceTimersByTime(45_000);
      });
    } else {
      act(() => {
        stopDrivingForLink();
      });
    }
    expect(getLastDriveEnded()).toMatchObject({ reason, drive: { boardType: 'moonboard' } });
    expect(bluetoothDisconnect).toHaveBeenCalledExactlyOnceWith('driving_ended');
  });

  it('lets go on a tap on You are driving the wall, a swipe drive too', () => {
    reads.current = { ...reads.current, disconnectWhenDrivingEnds: true };
    mount();
    driveLive();
    act(() => {
      stopDrivingForLink();
    });
    expect(bluetoothDisconnect).toHaveBeenCalledExactlyOnceWith('driving_ended');
  });

  // Settings › Board ends the drive, not the climber at the wall or the clock:
  // the link stays, so a settings toggle never frees a crew's board.
  it('keeps the board when the time setting is turned to Right away mid-drive', () => {
    reads.current = { ...reads.current, disconnectWhenDrivingEnds: true };
    const watcher = mount();
    openTimedDrive();
    watcher.change({ keepLighting: 'off' });
    expect(getLastDriveModeExitReason()).toBe('window_ended');
    expect(bluetoothDisconnect).not.toHaveBeenCalled();
  });

  it('keeps the board when In a session too is turned off in a crew', () => {
    reads.current = { ...reads.current, disconnectWhenDrivingEnds: true, isCrew: true };
    const watcher = mount();
    openTimedDrive();
    watcher.change({ drivesInSession: false });
    expect(getLastDriveModeExitReason()).toBe('window_ended');
    expect(bluetoothDisconnect).not.toHaveBeenCalled();
  });

  // With In a session too off, a crewmate joining ends a solo timed drive. The
  // owner excluded session changes: nobody at the wall, and no clock, ended it.
  it('keeps the board when a crew forms under a solo timed drive with In a session too off', () => {
    reads.current = { ...reads.current, disconnectWhenDrivingEnds: true, drivesInSession: false, isCrew: false };
    const watcher = mount();
    openTimedDrive();
    expect(getDriveMode()).toMatchObject({ phase: 'live', windowMs: 45_000 });
    watcher.change({ isCrew: true });
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('window_ended');
    expect(bluetoothDisconnect).not.toHaveBeenCalled();
  });

  it.each<[string, Partial<Reads> | null, DriveModeExitReason]>([
    ['the link drops', { isConnected: false }, 'link_dropped'],
    ['the session changes', { sessionId: 'session-2' }, 'session_changed'],
    ['the board changes', { boardId: 9 }, 'board_changed'],
    ['the climber signs out', { isAuthenticated: false }, 'signed_out'],
    ['the first light fails', null, 'commit_failed'],
  ])('never lets go when %s', (_case, change, reason) => {
    reads.current = { ...reads.current, disconnectWhenDrivingEnds: true };
    const watcher = mount();
    driveLive();
    watcher.change({});
    if (change) watcher.change(change);
    else
      act(() => {
        exitDriveMode('commit_failed');
      });
    expect(getLastDriveModeExitReason()).toBe(reason);
    expect(bluetoothDisconnect).not.toHaveBeenCalled();
  });

  it('never lets go when arming times out or the connect fails', () => {
    vi.useFakeTimers();
    reads.current = { ...reads.current, disconnectWhenDrivingEnds: true, isConnected: false, boardId: null };
    const watcher = mount();
    act(() => enterDriveMode({ startedBy: 'swipe', sessionId: 'session-1', boardId: null }));
    watcher.change({ loading: true });
    watcher.change({ loading: false });
    expect(getLastDriveModeExitReason()).toBe('connect_failed');
    reads.current = { ...reads.current, isConnected: true };
    watcher.change({});
    act(() => enterDriveMode({ startedBy: 'swipe', sessionId: 'session-1', boardId: 7 }));
    act(() => {
      vi.advanceTimersByTime(DRIVE_ARMING_TIMEOUT_MS);
    });
    expect(getLastDriveModeExitReason()).toBe('arming_timed_out');
    expect(bluetoothDisconnect).not.toHaveBeenCalled();
  });

  it('keeps the board with the setting off, however the drive ends', () => {
    vi.useFakeTimers();
    mount();
    openTimedDrive();
    act(() => {
      vi.advanceTimersByTime(45_000);
    });
    driveLive();
    act(() => {
      stopDrivingForLink();
    });
    expect(bluetoothDisconnect).not.toHaveBeenCalled();
  });

  it('has nothing to let go on a wall with no lights: no Bluetooth link', () => {
    reads.current = {
      ...reads.current,
      disconnectWhenDrivingEnds: true,
      isConnected: false,
      virtualWallHeld: true,
    };
    mount();
    driveLive();
    act(() => {
      stopDrivingForLink();
    });
    expect(bluetoothDisconnect).not.toHaveBeenCalled();
  });

  // A crewmate's put-up ends the timed drive; their climb goes up through this
  // phone's link first, so the board is let go once it is lit, never before.
  it('after a crewmate’s put-up, lets go once their climb is lit', async () => {
    vi.useFakeTimers();
    reads.current = {
      ...reads.current,
      disconnectWhenDrivingEnds: true,
      isCrew: true,
      currentClimbQueueItem: queueItem('q-1', 'Mine'),
    };
    const watcher = mount();
    act(() => {
      enterDriveMode({
        startedBy: 'tap',
        sessionId: reads.current.sessionId,
        boardId: reads.current.boardId,
        windowMs: 45_000,
        windowSetting: 'putOnBoardKeepsLighting',
      });
    });
    act(() => emitWallConfirm('climb-q-1', 'self'));
    act(() => crewMove('q-2'));
    expect(getLastDriveModeExitReason()).toBe('window_ended');
    expect(bluetoothDisconnect).not.toHaveBeenCalled();
    watcher.change({ currentClimbQueueItem: queueItem('q-2', 'Crimp Ladder') });
    await act(async () => {
      emitWallConfirm('climb-q-2', 'self');
      await Promise.resolve();
    });
    expect(bluetoothDisconnect).toHaveBeenCalledExactlyOnceWith('driving_ended');
  });

  // The confirm bus also replays the session's confirms: another climb's (a
  // late echo of this phone's own, or any member's relay) never ends the wait.
  // A relay of their climb does, the same as this phone's own confirm of it.
  it('after a crewmate’s put-up, waits for their climb, not any confirm', async () => {
    vi.useFakeTimers();
    reads.current = {
      ...reads.current,
      disconnectWhenDrivingEnds: true,
      isCrew: true,
      currentClimbQueueItem: queueItem('q-1', 'Mine'),
    };
    const watcher = mount();
    openTimedDrive();
    act(() => crewMove('q-2'));
    watcher.change({ currentClimbQueueItem: queueItem('q-2', 'Crimp Ladder') });
    await act(async () => {
      emitWallConfirm('climb-q-1', 'relay');
      emitWallConfirm('climb-elsewhere', 'relay');
      await Promise.resolve();
    });
    expect(bluetoothDisconnect).not.toHaveBeenCalled();
    await act(async () => {
      emitWallConfirm('climb-q-2', 'relay');
      await Promise.resolve();
    });
    expect(bluetoothDisconnect).toHaveBeenCalledExactlyOnceWith('driving_ended');
  });

  it('after a crewmate’s put-up, lets go anyway once the wait runs out', async () => {
    vi.useFakeTimers();
    reads.current = {
      ...reads.current,
      disconnectWhenDrivingEnds: true,
      isCrew: true,
      currentClimbQueueItem: queueItem('q-1', 'Mine'),
    };
    mount();
    openTimedDrive();
    act(() => crewMove('q-2'));
    await act(async () => {
      vi.advanceTimersByTime(CREW_PUT_UP_DISCONNECT_WAIT_MS - 1);
      await Promise.resolve();
    });
    expect(bluetoothDisconnect).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(bluetoothDisconnect).toHaveBeenCalledExactlyOnceWith('driving_ended');
  });

  it('keeps the board when a new drive took it during the wait', async () => {
    vi.useFakeTimers();
    reads.current = {
      ...reads.current,
      disconnectWhenDrivingEnds: true,
      isCrew: true,
      currentClimbQueueItem: queueItem('q-1', 'Mine'),
    };
    mount();
    openTimedDrive();
    act(() => crewMove('q-2'));
    // The climber swipes to drive again before the crewmate's climb lit.
    driveLive();
    await act(async () => {
      vi.advanceTimersByTime(CREW_PUT_UP_DISCONNECT_WAIT_MS);
      await Promise.resolve();
    });
    expect(bluetoothDisconnect).not.toHaveBeenCalled();
  });

  // A press on the Lock Screen or the notification after a timed drive ran out
  // (the app was suspended, so its timer never fired) is the climber at the
  // wall lighting a climb: the old drive ends at its end, but the board stays.
  it('keeps the board when an iOS Lock Screen press finds the timed drive over and starts its own', () => {
    vi.useFakeTimers();
    reads.current = { ...reads.current, disconnectWhenDrivingEnds: true };
    mount();
    openTimedDrive();
    vi.setSystemTime(Date.now() + 60_000);
    lockScreen.snapshot = {
      sessionId: 'session-1',
      mode: 'window',
      endsAtMs: Date.now() + 35_000,
      windowSeconds: 45,
      family: 'general',
      source: 'lockScreen',
      updatedAtMs: Date.now() - 10_000,
    };
    act(() => {
      for (const listener of appState.listeners) listener('active');
    });
    expect(effects.track).toHaveBeenCalledWith(
      'Drive Mode Ended',
      expect.objectContaining({ reason: 'window_ended', startedBy: 'tap' }),
    );
    expect(getDriveMode()).toMatchObject({ phase: 'live', startedBy: 'lock_screen' });
    expect(bluetoothDisconnect).not.toHaveBeenCalled();
  });

  // Right away (or any setting that starts no drive from a press): the iOS
  // intent lights its one climb and writes nothing, so there is no write to
  // replace the old drive. The press's own queueNavigate ends it, keeping the
  // board, as Android's press does.
  it('keeps the board when an iOS Lock Screen press under Right away finds the timed drive over', () => {
    vi.useFakeTimers();
    reads.current = { ...reads.current, disconnectWhenDrivingEnds: true };
    mount();
    openTimedDrive();
    vi.setSystemTime(Date.now() + 60_000);
    act(() => {
      for (const listener of lockScreen.navigateListeners) {
        listener({ action: 'next', currentIndex: 1, correlationId: 'corr-1' });
      }
    });
    expect(getLastDriveModeExitReason()).toBe('window_ended');
    expect(getDriveMode()).toBeNull();
    act(() => {
      for (const listener of appState.listeners) listener('active');
    });
    expect(bluetoothDisconnect).not.toHaveBeenCalled();
  });

  // No press heard before the app came back: the clock ended the drive, and the
  // setting lets go of the board (the base's rule for a timed drive that ran out).
  it('lets go when the app comes back to a timed drive that ran out with no press heard', () => {
    vi.useFakeTimers();
    reads.current = { ...reads.current, disconnectWhenDrivingEnds: true };
    mount();
    openTimedDrive();
    vi.setSystemTime(Date.now() + 60_000);
    act(() => {
      for (const listener of appState.listeners) listener('active');
    });
    expect(getLastDriveModeExitReason()).toBe('window_ended');
    expect(bluetoothDisconnect).toHaveBeenCalledExactlyOnceWith('driving_ended');
  });

  // iOS: native writes a press's drive only after its board write, and JS
  // hears the press later still. The intent stamps the press in flight first,
  // so a catch-up in that gap waits instead of ending the drive at the clock
  // and letting go of the board under the press.
  describe('an iOS Lock Screen press in flight', () => {
    function pressInFlight(expiresInMs = 8_000): void {
      lockScreen.press = { pressId: 'press-1', expiresAtMs: Date.now() + expiresInMs };
    }

    function settlePress(): void {
      if (lockScreen.press) lockScreen.press = { ...lockScreen.press, settledAtMs: Date.now() };
    }

    function foreground(): void {
      act(() => {
        for (const listener of appState.listeners) listener('active');
      });
    }

    function lapsedTimedDrive(): void {
      vi.useFakeTimers();
      reads.current = { ...reads.current, disconnectWhenDrivingEnds: true };
      mount();
      openTimedDrive();
      // Suspended past its end: the timer never fired.
      vi.setSystemTime(Date.now() + 60_000);
    }

    it('keeps the timed drive and the board while the press is on its way', () => {
      lapsedTimedDrive();
      pressInFlight();
      foreground();
      expect(getDriveMode()).toMatchObject({ phase: 'live', startedBy: 'tap' });
      expect(bluetoothDisconnect).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(LOCK_SCREEN_PRESS_RECHECK_MS * 4);
      });
      expect(getDriveMode()).toMatchObject({ phase: 'live', startedBy: 'tap' });
      expect(bluetoothDisconnect).not.toHaveBeenCalled();
    });

    it('under Right away, ends it keeping the board once the press settles, before its queueNavigate', () => {
      lapsedTimedDrive();
      pressInFlight();
      foreground();
      // The board write is done; the intent wrote no drive (Right away).
      settlePress();
      act(() => {
        vi.advanceTimersByTime(LOCK_SCREEN_PRESS_RECHECK_MS);
      });
      expect(getDriveMode()).toBeNull();
      expect(getLastDriveEnded()).toMatchObject({ reason: 'window_ended', keepLink: true });
      // Its queueNavigate lands after: nothing more to end, nothing let go.
      act(() => {
        for (const listener of lockScreen.navigateListeners) {
          listener({ action: 'next', currentIndex: 1, correlationId: 'corr-1' });
        }
      });
      expect(bluetoothDisconnect).not.toHaveBeenCalled();
    });

    it('takes on the drive the press started once it settles, keeping the board', () => {
      lapsedTimedDrive();
      pressInFlight();
      foreground();
      lockScreen.snapshot = {
        sessionId: 'session-1',
        mode: 'window',
        endsAtMs: Date.now() + 45_000,
        windowSeconds: 45,
        family: 'general',
        source: 'lockScreen',
        updatedAtMs: Date.now(),
      };
      settlePress();
      act(() => {
        vi.advanceTimersByTime(LOCK_SCREEN_PRESS_RECHECK_MS);
      });
      // The old drive ended at its end, and the press's own took its place.
      expect(effects.track).toHaveBeenCalledWith(
        'Drive Mode Ended',
        expect.objectContaining({ reason: 'window_ended', startedBy: 'tap' }),
      );
      expect(getDriveMode()).toMatchObject({ phase: 'live', startedBy: 'lock_screen' });
      expect(bluetoothDisconnect).not.toHaveBeenCalled();
    });

    it('holds the timer at the end too, while the app runs in the background', () => {
      vi.useFakeTimers();
      reads.current = { ...reads.current, disconnectWhenDrivingEnds: true };
      mount();
      openTimedDrive();
      act(() => {
        vi.advanceTimersByTime(45_000 - 100);
      });
      pressInFlight();
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(getDriveMode()?.phase).toBe('live');
      expect(bluetoothDisconnect).not.toHaveBeenCalled();
    });

    it('ends at the clock and lets go once the stamp runs out with no press landing', () => {
      lapsedTimedDrive();
      pressInFlight(1_000);
      foreground();
      expect(getDriveMode()?.phase).toBe('live');
      act(() => {
        vi.advanceTimersByTime(1_000 - 1);
      });
      expect(getDriveMode()?.phase).toBe('live');
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(getDriveMode()).toBeNull();
      expect(getLastDriveEnded()).toMatchObject({ reason: 'window_ended', keepLink: false });
      expect(bluetoothDisconnect).toHaveBeenCalledExactlyOnceWith('driving_ended');
    });

    it('keeps the board when the party server turned the press down after the end', () => {
      lapsedTimedDrive();
      pressInFlight();
      foreground();
      // The intent settles a turned-down press's stamp rather than removing it,
      // since it may cover an earlier press still writing. No queueNavigate follows.
      settlePress();
      act(() => {
        vi.advanceTimersByTime(LOCK_SCREEN_PRESS_RECHECK_MS);
      });
      expect(getDriveMode()).toBeNull();
      expect(getLastDriveEnded()).toMatchObject({ reason: 'window_ended', keepLink: true });
      expect(bluetoothDisconnect).not.toHaveBeenCalled();
    });

    it('lets go as before when the last press settled before the drive ended', () => {
      lapsedTimedDrive();
      lockScreen.press = { pressId: 'press-0', expiresAtMs: Date.now() - 100_000, settledAtMs: Date.now() - 110_000 };
      foreground();
      expect(getLastDriveEnded()).toMatchObject({ reason: 'window_ended', keepLink: false });
      expect(bluetoothDisconnect).toHaveBeenCalledExactlyOnceWith('driving_ended');
    });
  });

  it('keeps the board when an Android notification press finds the timed drive over', () => {
    vi.useFakeTimers();
    lockScreen.android = true;
    reads.current = {
      ...reads.current,
      disconnectWhenDrivingEnds: true,
      boardName: 'kilter',
      queueLength: 3,
    };
    mount();
    openTimedDrive();
    vi.setSystemTime(Date.now() + 60_000);
    act(() => {
      for (const listener of lockScreen.navigateListeners) {
        listener({ action: 'next', currentIndex: 1, correlationId: 'corr-1' });
      }
    });
    expect(getDriveMode()).toMatchObject({ phase: 'arming', startedBy: 'lock_screen' });
    expect(bluetoothDisconnect).not.toHaveBeenCalled();
  });
});
