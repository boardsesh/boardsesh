// @vitest-environment jsdom
// #7113: the one owner that ends a drive, mounted once in the root layout. It
// reads the Bluetooth link, the session, the bound board and sign-in.
import { act, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Reads = {
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
vi.mock('../../../providers/queue-provider', () => ({
  useQueueSessionControls: () => ({ sessionId: reads.current.sessionId }),
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

import { DriveModeWatcher } from '../DriveModeWatcher';
import {
  DRIVE_ARMING_TIMEOUT_MS,
  enterDriveMode,
  getDriveMode,
  getLastDriveModeExitReason,
  isDrivingStoppedForLink,
  markDriveLive,
  resetDriveModeForTests,
  stopDrivingForLink,
} from '../drive-mode-store';

const DEFAULT_READS: Reads = {
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
});
afterEach(() => {
  vi.useRealTimers();
  resetDriveModeForTests();
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
