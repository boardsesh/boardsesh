// @vitest-environment jsdom
// #7113: the one owner that ends a drive, mounted once in the root layout. It
// reads the Bluetooth link, the session, the bound board and sign-in.
import { act, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  }),
}));
// The queue is read narrowly: the current climb's uuid as the trigger, the
// snapshot for the item. A stable snapshot reader, like the provider's.
const getQueueSnapshot = () => ({ queue: [], currentClimbQueueItem: reads.current.currentClimbQueueItem });
vi.mock('../../../providers/queue-provider', () => ({
  useQueueSessionControls: () => ({ sessionId: reads.current.sessionId }),
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
  useSetting: () => [reads.current.lightOnSwipe, vi.fn()],
}));
vi.mock('../../../providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: reads.current.isAuthenticated }),
}));

import { emitWallConfirm } from '@boardsesh/play-view';
import { DriveModeWatcher } from '../DriveModeWatcher';
import { noteOwnMove, noteRelayReceipt, clearRelayReceipt } from '../../../lib/relay-receipt';
import { CREW_PUT_UP_NOTICE_MS, clearCrewPutUp, getCrewPutUp } from '../crew-put-up-store';
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
    enterDriveMode({ sessionId: reads.current.sessionId, boardId: reads.current.boardId });
    markDriveLive();
  });
}

beforeEach(() => {
  reads.current = { ...DEFAULT_READS };
  resetDriveModeForTests();
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
    act(() => enterDriveMode({ sessionId: 'session-1', boardId: null }));
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
    act(() => enterDriveMode({ sessionId: 'session-1', boardId: null }));
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
    act(() => enterDriveMode({ sessionId: 'session-1', boardId: 7 }));
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
    act(() => enterDriveMode({ sessionId: 'session-1', boardId: 7 }));
    expect(getDriveMode()?.phase).toBe('arming');
    act(() => emitWallConfirm('climb-a'));
    expect(getDriveMode()).toMatchObject({ phase: 'live', climbsLit: 1 });
    expect(effects.hapticSuccess).toHaveBeenCalledOnce();
  });

  it('never goes live on a confirm without this phone’s link', () => {
    reads.current = { ...reads.current, isConnected: false };
    mount();
    act(() => enterDriveMode({ sessionId: 'session-1', boardId: 7 }));
    act(() => emitWallConfirm('climb-a'));
    expect(getDriveMode()).toMatchObject({ phase: 'arming', climbsLit: 0 });
  });

  it('counts each new climb lit once, the swipe’s own first; re-sends and echoes are not new', () => {
    mount();
    act(() => enterDriveMode({ sessionId: 'session-1', boardId: 7 }));
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
      enterDriveMode({ sessionId: 'session-1', boardId: 7, now: 1 });
      emitWallConfirm('climb-a');
      exitDriveMode('link_dropped');
      enterDriveMode({ sessionId: 'session-1', boardId: 7, now: 2 });
      emitWallConfirm('climb-a');
    });
    expect(getDriveMode()?.climbsLit).toBe(1);
  });

  it('learns the bound board once live, so a later change of board ends the drive', () => {
    const watcher = mount();
    act(() => {
      enterDriveMode({ sessionId: 'session-1', boardId: null });
      markDriveLive();
    });
    watcher.change({});
    expect(getDriveMode()?.boardId).toBe(7);
    watcher.change({ boardId: 9 });
    expect(getLastDriveModeExitReason()).toBe('board_changed');
  });
});
