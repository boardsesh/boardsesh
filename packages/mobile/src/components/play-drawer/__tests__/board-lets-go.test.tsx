// @vitest-environment jsdom
// Board plan item 8: the board lets go mid-drive. `DriveModeWatcher` ends the
// drive; a drop this phone didn't make is said once (a warning buzz, one
// screen-reader line, the top-bar caption), naming who took the board when
// presence knows.
import { act, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BoardPresenceCurrentContext,
  BoardPresenceProvider,
  type BoardPresenceClient,
  type BoardPresenceCurrentState,
} from '@boardsesh/board-presence-react';
import type {
  BoardConnectionHolder,
  BoardPresenceClimb,
  BoardPresenceEvent,
  BoardPresenceStats,
} from '@boardsesh/shared-schema';

type Reads = {
  isConnected: boolean;
  virtualWallHeld: boolean;
  loading: boolean;
  sessionId: string | null;
  boardId: number | null;
  isAuthenticated: boolean;
  viewerUserId: string | null;
  holder: BoardConnectionHolder | null;
  lastConnectionSeq: number;
  /**
   * Presence's last change of holder. Null: every holder change so far was a
   * live push, so it is `lastConnectionSeq`. Only a catch-up sets it apart.
   */
  lastHolderChangeSeq: number | null;
  /** The newest climb presence has for the wall, by its sequence; null for none. */
  wallClimbSeq: number | null;
};
const DEFAULT_READS: Reads = {
  isConnected: true,
  virtualWallHeld: false,
  loading: false,
  sessionId: 'session-1',
  boardId: 7,
  isAuthenticated: true,
  viewerUserId: 'user-me',
  // This phone holds the board, as its own sends made it.
  holder: { userId: 'user-me', displayName: 'Me' },
  lastConnectionSeq: 4,
  lastHolderChangeSeq: null,
  wallClimbSeq: null,
};
const reads = vi.hoisted((): { current: Reads } => ({ current: {} as Reads }));

vi.mock('../../../providers/bluetooth-provider', () => ({
  useOptionalBluetoothContext: () => ({
    isConnected: reads.current.isConnected,
    virtualWallHeld: reads.current.virtualWallHeld,
    loading: reads.current.loading,
    boardName: 'kilter',
    disconnect: vi.fn(async () => undefined),
  }),
}));
vi.mock('../../../providers/feature-flags-provider', () => ({ useWallSwipeToDriveEnabled: () => true }));
const getQueueSnapshot = () => ({ queue: [], currentClimbQueueItem: null });
vi.mock('../../../providers/queue-provider', () => ({
  useQueueSessionControls: () => ({ sessionId: reads.current.sessionId }),
  useIsCrewSession: () => false,
  useActiveClimbUuid: () => null,
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
        return ['45', vi.fn()];
      case 'putOnBoardDrivesInSession':
        return [true, vi.fn()];
      case 'disconnectWhenDrivingEnds':
        return [false, vi.fn()];
      case 'alwaysDrive':
        return [false, vi.fn()];
      default:
        throw new Error(`unexpected setting ${key}`);
    }
  },
}));
vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock('../../../lib/live-activity/live-activity-plugin', () => ({
  readLiveActivityLightingWindow: () => null,
  addWidgetQueueNavigateListener: () => () => undefined,
  addLockScreenDriveStopListener: () => () => undefined,
  isAndroidSessionPresence: false,
}));
vi.mock('../../../providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: reads.current.isAuthenticated }),
}));
vi.mock('../../../hooks/use-viewer-user-id', () => ({ useViewerUserId: () => reads.current.viewerUserId }));

import { DriveModeWatcher } from '../DriveModeWatcher';
import { noteLinkEnded, resetLinkEndForTests } from '../../../lib/ble/link-end-store';
import { resetLockScreenLightingForTests } from '../lock-screen-lighting';
import {
  LETS_GO_NOTICE_MS,
  LETS_GO_STALE_MS,
  LETS_GO_TAKER_WAIT_MS,
  clearLetsGo,
  getLetsGo,
} from '../board-lets-go-store';
import {
  enterDriveMode,
  getDriveMode,
  getLastDriveModeExitReason,
  markDriveLive,
  resetDriveModeForTests,
  stopDrivingForLink,
} from '../drive-mode-store';

function tree() {
  const { wallClimbSeq } = reads.current;
  const presence = {
    holder: reads.current.holder,
    lastConnectionSeq: reads.current.lastConnectionSeq,
    lastHolderChangeSeq: reads.current.lastHolderChangeSeq ?? reads.current.lastConnectionSeq,
    currentClimb: wallClimbSeq === null ? null : { climbUuid: `climb-${wallClimbSeq}`, seq: wallClimbSeq },
    previousClimb: null,
  } as unknown as BoardPresenceCurrentState;
  return createElement(BoardPresenceCurrentContext.Provider, { value: presence }, createElement(DriveModeWatcher));
}

function mount() {
  const view = render(tree());
  const change = (next: Partial<Reads>) => {
    // A holder push here is a live one: it changed the holder at its sequence.
    const livePush = ('holder' in next || 'lastConnectionSeq' in next) && !('lastHolderChangeSeq' in next);
    act(() => {
      reads.current = { ...reads.current, ...next, ...(livePush ? { lastHolderChangeSeq: null } : {}) };
      view.rerender(tree());
    });
  };
  return {
    change,
    /**
     * A presence catch-up that reads back the same holder: it moves
     * `lastConnectionSeq` up to `upToSeq` and leaves the holder's change where
     * it was (the reducer's rule; the real provider runs it below).
     */
    catchUp(upToSeq: number) {
      const { lastHolderChangeSeq, lastConnectionSeq } = reads.current;
      change({ lastConnectionSeq: upToSeq, lastHolderChangeSeq: lastHolderChangeSeq ?? lastConnectionSeq });
    },
    unmount: () => view.unmount(),
  };
}

function driveLive() {
  act(() => {
    enterDriveMode({ startedBy: 'swipe', sessionId: reads.current.sessionId, boardId: reads.current.boardId });
    markDriveLive();
  });
}

/** The Bluetooth provider's note, then the link going: one render, as the hook drops `isConnected` after it. */
function linkEnds(
  watcher: Pick<ReturnType<typeof mount>, 'change'>,
  end: { deliberate: boolean; takenByPeer?: boolean },
  next: Partial<Reads> = { isConnected: false },
) {
  noteLinkEnded(end);
  watcher.change(next);
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function driveEndedCalls() {
  return effects.track.mock.calls.filter(([name]) => name === 'Drive Mode Ended');
}

beforeEach(() => {
  vi.useFakeTimers();
  reads.current = { ...DEFAULT_READS };
  resetDriveModeForTests();
  resetLinkEndForTests();
  resetLockScreenLightingForTests();
  clearLetsGo();
  for (const effect of Object.values(effects)) effect.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  resetDriveModeForTests();
  resetLinkEndForTests();
  clearLetsGo();
});

describe('the board lets go mid-drive', () => {
  it('says a plain drop once, after the wait for a taker, with how to reconnect', () => {
    const watcher = mount();
    driveLive();
    watcher.change({});
    // The phone's own release frees the board: the holder slot empties.
    linkEnds(watcher, { deliberate: false });
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('link_dropped');
    watcher.change({ holder: null, lastConnectionSeq: 5 });
    // Waiting to hear whether another phone took it: nothing said, nothing sent.
    advance(LETS_GO_TAKER_WAIT_MS - 1);
    expect(effects.hapticWarning).not.toHaveBeenCalled();
    expect(effects.announceQueued).not.toHaveBeenCalled();
    expect(getLetsGo()).toBeNull();
    expect(driveEndedCalls()).toHaveLength(0);
    advance(1);
    expect(effects.hapticWarning).toHaveBeenCalledTimes(1);
    expect(effects.announceQueued).toHaveBeenCalledTimes(1);
    expect(effects.announceQueued).toHaveBeenCalledWith('playView.wallControl.boardDropped');
    expect(getLetsGo()).toEqual({ kind: 'dropped' });
    expect(driveEndedCalls()).toHaveLength(1);
    expect(driveEndedCalls()[0]?.[1]).toMatchObject({ reason: 'link_dropped', takenBy: null });
    // Never again for this end, whatever presence or time brings.
    watcher.change({ holder: { userId: 'user-sam', displayName: 'Sam' }, lastConnectionSeq: 6 });
    advance(LETS_GO_TAKER_WAIT_MS * 3);
    expect(effects.hapticWarning).toHaveBeenCalledTimes(1);
    expect(effects.announceQueued).toHaveBeenCalledTimes(1);
    expect(driveEndedCalls()).toHaveLength(1);
  });

  it('names a crewmate who took the board as soon as presence says so', () => {
    const watcher = mount();
    driveLive();
    watcher.change({});
    linkEnds(watcher, { deliberate: false });
    advance(1_200);
    expect(effects.hapticWarning).not.toHaveBeenCalled();
    // Sam's phone lit its first climb: the holder event lands.
    watcher.change({ holder: { userId: 'user-sam', displayName: '  Sam  ' }, lastConnectionSeq: 5 });
    expect(effects.hapticWarning).toHaveBeenCalledTimes(1);
    expect(effects.announceQueued).toHaveBeenCalledTimes(1);
    expect(effects.announceQueued).toHaveBeenCalledWith('playView.wallControl.boardTakenBy {"name":"Sam"}');
    expect(getLetsGo()).toEqual({ kind: 'taken_named', name: 'Sam' });
    expect(driveEndedCalls()).toHaveLength(1);
    expect(driveEndedCalls()[0]?.[1]).toMatchObject({ reason: 'link_dropped', takenBy: 'named' });
    // The wait's own timer says nothing more.
    advance(LETS_GO_TAKER_WAIT_MS);
    expect(effects.hapticWarning).toHaveBeenCalledTimes(1);
    expect(effects.announceQueued).toHaveBeenCalledTimes(1);
  });

  it('names the taker at once when presence already had them at the drop', () => {
    const watcher = mount();
    driveLive();
    watcher.change({});
    // The box let go of this phone late: Sam's hold landed first.
    watcher.change({ holder: { userId: 'user-sam', displayName: 'Sam' }, lastConnectionSeq: 5 });
    linkEnds(watcher, { deliberate: false });
    expect(getLetsGo()).toEqual({ kind: 'taken_named', name: 'Sam' });
    expect(effects.hapticWarning).toHaveBeenCalledTimes(1);
  });

  it('says another phone has the board when the holder is anonymous', () => {
    const watcher = mount();
    driveLive();
    watcher.change({});
    linkEnds(watcher, { deliberate: false });
    watcher.change({ holder: { userId: null, displayName: null }, lastConnectionSeq: 5 });
    expect(effects.hapticWarning).toHaveBeenCalledTimes(1);
    expect(effects.announceQueued).toHaveBeenCalledWith('playView.wallControl.boardTakenOtherPhone');
    expect(getLetsGo()).toEqual({ kind: 'taken' });
    expect(driveEndedCalls()[0]?.[1]).toMatchObject({ takenBy: 'anonymous' });
  });

  it('says another phone has the board when a signed-in holder has no name to show', () => {
    const watcher = mount();
    driveLive();
    watcher.change({});
    linkEnds(watcher, { deliberate: false });
    watcher.change({ holder: { userId: 'user-sam', displayName: ' ' }, lastConnectionSeq: 5 });
    expect(getLetsGo()).toEqual({ kind: 'taken' });
  });

  it('never names a holder left over from before the drive', () => {
    // Sam's stale hold, and this phone's reports never replaced it.
    reads.current = { ...reads.current, holder: { userId: 'user-sam', displayName: 'Sam' }, lastConnectionSeq: 4 };
    const watcher = mount();
    driveLive();
    watcher.change({});
    linkEnds(watcher, { deliberate: false });
    expect(effects.hapticWarning).not.toHaveBeenCalled();
    advance(LETS_GO_TAKER_WAIT_MS);
    expect(getLetsGo()).toEqual({ kind: 'dropped' });
  });

  it('never names a holder from before the drive that a catch-up re-reads during the wait', () => {
    // Sam lit the wall before this drive (sequence 12), and this phone's
    // reports never replaced Sam's hold.
    reads.current = {
      ...reads.current,
      holder: { userId: 'user-sam', displayName: 'Sam' },
      lastConnectionSeq: 4,
      wallClimbSeq: 12,
    };
    const watcher = mount();
    driveLive();
    watcher.change({});
    linkEnds(watcher, { deliberate: false });
    advance(1_000);
    // The foreground catch-up: the same holder, read up to past the newest climb.
    watcher.catchUp(13);
    expect(effects.hapticWarning).not.toHaveBeenCalled();
    advance(LETS_GO_TAKER_WAIT_MS);
    expect(getLetsGo()).toEqual({ kind: 'dropped' });
    expect(driveEndedCalls()[0]?.[1]).toMatchObject({ takenBy: null });
  });

  it('names the climber who held the board before the drive when they take it back', () => {
    reads.current = {
      ...reads.current,
      holder: { userId: 'user-sam', displayName: 'Sam' },
      lastConnectionSeq: 4,
      wallClimbSeq: 4,
    };
    const watcher = mount();
    driveLive();
    // This phone's first climb made it the holder.
    watcher.change({ holder: { userId: 'user-me', displayName: 'Me' }, lastConnectionSeq: 5, wallClimbSeq: 5 });
    linkEnds(watcher, { deliberate: false });
    // Sam's phone took the box and lit its climb.
    watcher.change({ holder: { userId: 'user-sam', displayName: 'Sam' }, lastConnectionSeq: 6, wallClimbSeq: 6 });
    expect(getLetsGo()).toEqual({ kind: 'taken_named', name: 'Sam' });
  });

  it('never names the climber’s own account', () => {
    const watcher = mount();
    driveLive();
    watcher.change({});
    linkEnds(watcher, { deliberate: false });
    // Their other phone, or this one's last send echoing: presence knows accounts.
    watcher.change({ holder: { userId: 'user-me', displayName: 'Me' }, lastConnectionSeq: 5 });
    expect(effects.hapticWarning).not.toHaveBeenCalled();
    advance(LETS_GO_TAKER_WAIT_MS);
    expect(getLetsGo()).toEqual({ kind: 'dropped' });
  });

  it('counts an anonymous holder only after the drop when the climber is signed out too', () => {
    reads.current = {
      ...reads.current,
      isAuthenticated: false,
      viewerUserId: null,
      // This phone's own hold reads as anonymous.
      holder: { userId: null, displayName: null },
      lastConnectionSeq: 4,
    };
    const watcher = mount();
    driveLive();
    // Its own take moved the holder during the drive, still before the drop.
    watcher.change({ lastConnectionSeq: 5 });
    linkEnds(watcher, { deliberate: false });
    expect(effects.hapticWarning).not.toHaveBeenCalled();
    // A new anonymous hold after the drop is another phone.
    watcher.change({ lastConnectionSeq: 6 });
    expect(getLetsGo()).toEqual({ kind: 'taken' });
  });

  it('never reads a catch-up of this phone’s own anonymous hold as another phone', () => {
    reads.current = {
      ...reads.current,
      isAuthenticated: false,
      viewerUserId: null,
      holder: { userId: null, displayName: null },
      lastConnectionSeq: 5,
      // This phone's own climbs, the newest at sequence 9: they never move the holder event.
      wallClimbSeq: 9,
    };
    const watcher = mount();
    driveLive();
    watcher.change({});
    linkEnds(watcher, { deliberate: false });
    // A catch-up re-reads the same anonymous hold up to past the newest climb.
    watcher.catchUp(10);
    expect(effects.hapticWarning).not.toHaveBeenCalled();
    advance(LETS_GO_TAKER_WAIT_MS);
    expect(getLetsGo()).toEqual({ kind: 'dropped' });
  });

  it('says another phone has a wall with no lights a later holder took, at once', () => {
    reads.current = { ...reads.current, isConnected: false, virtualWallHeld: true };
    const watcher = mount();
    driveLive();
    watcher.change({});
    linkEnds(watcher, { deliberate: false, takenByPeer: true }, { virtualWallHeld: false });
    expect(getLetsGo()).toEqual({ kind: 'taken' });
    expect(effects.hapticWarning).toHaveBeenCalledTimes(1);
  });

  it('names who took a wall with no lights when presence has their name', () => {
    reads.current = { ...reads.current, isConnected: false, virtualWallHeld: true };
    const watcher = mount();
    driveLive();
    watcher.change({});
    reads.current = { ...reads.current, holder: { userId: 'user-sam', displayName: 'Sam' }, lastConnectionSeq: 5 };
    linkEnds(watcher, { deliberate: false, takenByPeer: true }, { virtualWallHeld: false });
    expect(getLetsGo()).toEqual({ kind: 'taken_named', name: 'Sam' });
  });

  it('names who took a wall with no lights from a signed-out climber', () => {
    // A signed-out phone holds anonymously, so a holder with an account is never this phone.
    reads.current = {
      ...reads.current,
      isConnected: false,
      virtualWallHeld: true,
      isAuthenticated: false,
      viewerUserId: null,
      holder: null,
    };
    const watcher = mount();
    driveLive();
    watcher.change({});
    // Sam's hold is what released this phone: it is in presence by the drop.
    reads.current = { ...reads.current, holder: { userId: 'user-sam', displayName: 'Sam' }, lastConnectionSeq: 5 };
    linkEnds(watcher, { deliberate: false, takenByPeer: true }, { virtualWallHeld: false });
    expect(getLetsGo()).toEqual({ kind: 'taken_named', name: 'Sam' });
    expect(driveEndedCalls()[0]?.[1]).toMatchObject({ takenBy: 'named' });
  });

  it('says a plain drop when the wait’s timer runs, even with the clock stepped back', () => {
    const watcher = mount();
    driveLive();
    watcher.change({});
    linkEnds(watcher, { deliberate: false });
    // A clock adjust during the wait: the timer is what ends it, not the clock.
    vi.setSystemTime(Date.now() - 1_000);
    advance(LETS_GO_TAKER_WAIT_MS);
    expect(getLetsGo()).toEqual({ kind: 'dropped' });
    expect(effects.hapticWarning).toHaveBeenCalledTimes(1);
    expect(driveEndedCalls()).toHaveLength(1);
    expect(driveEndedCalls()[0]?.[1]).toMatchObject({ reason: 'link_dropped', takenBy: null });
  });

  describe('says nothing', () => {
    it('when the climber hung up mid-drive, and sends Drive Mode Ended at once', () => {
      const watcher = mount();
      driveLive();
      watcher.change({});
      linkEnds(watcher, { deliberate: true });
      expect(getLastDriveModeExitReason()).toBe('link_dropped');
      expect(driveEndedCalls()).toHaveLength(1);
      // No `takenBy`: the climber made this drop.
      expect(driveEndedCalls()[0]?.[1]).not.toHaveProperty('takenBy');
      watcher.change({ holder: { userId: 'user-sam', displayName: 'Sam' }, lastConnectionSeq: 5 });
      advance(LETS_GO_TAKER_WAIT_MS * 2);
      expect(effects.hapticWarning).not.toHaveBeenCalled();
      expect(effects.announceQueued).not.toHaveBeenCalled();
      expect(getLetsGo()).toBeNull();
    });

    it('when the climber stopped the drive themselves, then the link went', () => {
      const watcher = mount();
      driveLive();
      watcher.change({});
      act(() => {
        stopDrivingForLink();
      });
      expect(getLastDriveModeExitReason()).toBe('stopped');
      linkEnds(watcher, { deliberate: false });
      advance(LETS_GO_TAKER_WAIT_MS * 2);
      expect(effects.hapticWarning).not.toHaveBeenCalled();
      expect(effects.announceQueued).not.toHaveBeenCalled();
      expect(getLetsGo()).toBeNull();
    });

    it('when nobody was driving', () => {
      const watcher = mount();
      linkEnds(watcher, { deliberate: false });
      watcher.change({ holder: { userId: 'user-sam', displayName: 'Sam' }, lastConnectionSeq: 5 });
      advance(LETS_GO_TAKER_WAIT_MS * 2);
      expect(effects.hapticWarning).not.toHaveBeenCalled();
      expect(effects.announceQueued).not.toHaveBeenCalled();
      expect(getLetsGo()).toBeNull();
      expect(driveEndedCalls()).toHaveLength(0);
    });

    it('when the drop went unnoted', () => {
      const watcher = mount();
      driveLive();
      watcher.change({});
      watcher.change({ isConnected: false });
      advance(LETS_GO_TAKER_WAIT_MS * 2);
      expect(effects.hapticWarning).not.toHaveBeenCalled();
      expect(driveEndedCalls()).toHaveLength(1);
    });

    it('when the link comes back before the wait ends', () => {
      const watcher = mount();
      driveLive();
      watcher.change({});
      linkEnds(watcher, { deliberate: false });
      advance(2_000);
      watcher.change({ isConnected: true });
      advance(LETS_GO_TAKER_WAIT_MS);
      expect(effects.hapticWarning).not.toHaveBeenCalled();
      expect(getLetsGo()).toBeNull();
      expect(driveEndedCalls()).toHaveLength(1);
      expect(driveEndedCalls()[0]?.[1]).toMatchObject({ reason: 'link_dropped', takenBy: null });
    });

    it('when a connect starts before the wait ends', () => {
      const watcher = mount();
      driveLive();
      watcher.change({});
      linkEnds(watcher, { deliberate: false });
      watcher.change({ loading: true });
      advance(LETS_GO_TAKER_WAIT_MS);
      expect(effects.hapticWarning).not.toHaveBeenCalled();
    });

    it('when a new drive starts before the wait ends, sending the held end first', () => {
      const watcher = mount();
      driveLive();
      watcher.change({});
      linkEnds(watcher, { deliberate: false });
      act(() => {
        enterDriveMode({ startedBy: 'swipe', sessionId: 'session-1', boardId: 7 });
      });
      const names = effects.track.mock.calls.map(([name]) => name);
      expect(names.slice(-2)).toEqual(['Drive Mode Ended', 'Drive Mode Started']);
      watcher.change({});
      advance(LETS_GO_TAKER_WAIT_MS);
      expect(effects.hapticWarning).not.toHaveBeenCalled();
      expect(driveEndedCalls()).toHaveLength(1);
    });

    it('when the board changes before the wait ends', () => {
      const watcher = mount();
      driveLive();
      watcher.change({});
      linkEnds(watcher, { deliberate: false });
      watcher.change({ boardId: 9 });
      advance(LETS_GO_TAKER_WAIT_MS);
      expect(effects.hapticWarning).not.toHaveBeenCalled();
      expect(driveEndedCalls()).toHaveLength(1);
    });

    it('when the wait ran far past its end (a suspended app), but still sends Drive Mode Ended', () => {
      const watcher = mount();
      driveLive();
      watcher.change({});
      linkEnds(watcher, { deliberate: false });
      // The app slept: the clock moved on, the timer never ran.
      vi.setSystemTime(Date.now() + LETS_GO_STALE_MS + 1);
      advance(LETS_GO_TAKER_WAIT_MS);
      expect(effects.hapticWarning).not.toHaveBeenCalled();
      expect(effects.announceQueued).not.toHaveBeenCalled();
      expect(getLetsGo()).toBeNull();
      expect(driveEndedCalls()).toHaveLength(1);
    });

    it('when the watcher unmounts mid-wait, and still sends Drive Mode Ended', () => {
      const watcher = mount();
      driveLive();
      watcher.change({});
      linkEnds(watcher, { deliberate: false });
      watcher.unmount();
      expect(driveEndedCalls()).toHaveLength(1);
      advance(LETS_GO_TAKER_WAIT_MS);
      expect(effects.hapticWarning).not.toHaveBeenCalled();
    });
  });

  describe('the caption', () => {
    it('stays up for its time', () => {
      const watcher = mount();
      driveLive();
      watcher.change({});
      linkEnds(watcher, { deliberate: false });
      watcher.change({ holder: { userId: null, displayName: null }, lastConnectionSeq: 5 });
      advance(LETS_GO_NOTICE_MS - 1);
      expect(getLetsGo()).toEqual({ kind: 'taken' });
      advance(1);
      expect(getLetsGo()).toBeNull();
    });

    it('goes when the link is back', () => {
      const watcher = mount();
      driveLive();
      watcher.change({});
      linkEnds(watcher, { deliberate: false });
      advance(LETS_GO_TAKER_WAIT_MS);
      expect(getLetsGo()).toEqual({ kind: 'dropped' });
      watcher.change({ isConnected: true });
      expect(getLetsGo()).toBeNull();
    });

    it('goes when the board changes', () => {
      const watcher = mount();
      driveLive();
      watcher.change({});
      linkEnds(watcher, { deliberate: false });
      advance(LETS_GO_TAKER_WAIT_MS);
      watcher.change({ boardId: 9 });
      expect(getLetsGo()).toBeNull();
    });
  });
});

// The real presence provider and reducer under the watcher. A catch-up (the app
// back in the foreground, a reconnect) moves `lastConnectionSeq` through every
// stats event it repaired, so a tick on the board since the last catch-up put it
// one past the newest climb with the holder unchanged.
describe('the board lets go mid-drive, with presence catching up', () => {
  const NO_STATS: BoardPresenceStats = {
    climbsSentCount: 0,
    distinctClimbersCount: 0,
    hardestGrade: null,
    topGrade: null,
    lastSentAt: null,
  };
  const wallClimb = (seq: number): BoardPresenceClimb => ({
    climbUuid: `climb-${seq}`,
    seq,
    sentAt: new Date(Date.UTC(2026, 10, 1, 10, 0, seq)).toISOString(),
    angle: 40,
  });

  function presenceServer(server: { holder: BoardConnectionHolder | null; recent: BoardPresenceClimb[] }) {
    let push: ((event: BoardPresenceEvent) => void) | null = null;
    let reconnected: (() => void) | null = null;
    const client: BoardPresenceClient = {
      subscribeNowPlaying: (_boardId, onEvent) => {
        push = onEvent;
        return () => {
          push = null;
        };
      },
      onReconnect: (callback) => {
        reconnected = callback;
        return () => {
          reconnected = null;
        };
      },
      fetchRecentClimbs: async () => server.recent,
      fetchStats: async () => NO_STATS,
      fetchConnection: async () => server.holder,
      reportClimb: async () => true,
      resolveBoardForSerial: vi.fn(),
    };
    return {
      client,
      emit: (event: BoardPresenceEvent) => act(() => push?.(event)),
      /** A tick on the board: its stats event takes the next sequence. */
      tick: (seq: number) => act(() => push?.({ __typename: 'BoardStatsUpdated', stats: NO_STATS, seq })),
      /** The socket came back: presence re-reads recent climbs, stats and the holder. */
      async catchUp(next: { holder: BoardConnectionHolder | null; recent: BoardPresenceClimb[] }) {
        Object.assign(server, next);
        await act(async () => {
          reconnected?.();
          await Promise.resolve();
        });
      },
    };
  }

  async function mountOn(client: BoardPresenceClient) {
    const element = () =>
      createElement(BoardPresenceProvider, {
        boardId: reads.current.boardId,
        client,
        children: createElement(DriveModeWatcher),
      });
    const view = render(element());
    // The first backfill, stats and holder seed.
    await act(async () => {
      await Promise.resolve();
    });
    return {
      change(next: Partial<Reads>) {
        act(() => {
          reads.current = { ...reads.current, ...next };
          view.rerender(element());
        });
      },
    };
  }

  it('never reads a catch-up of a signed-out climber’s own hold as another phone', async () => {
    reads.current = { ...reads.current, isAuthenticated: false, viewerUserId: null };
    const anonymous: BoardConnectionHolder = { userId: null, displayName: null };
    const server = presenceServer({ holder: null, recent: [wallClimb(8)] });
    const watcher = await mountOn(server.client);
    driveLive();
    // This phone's climb, and its hold on the board.
    server.emit({ __typename: 'BoardClimbSet', climb: wallClimb(9) });
    server.emit({ __typename: 'BoardConnectionChanged', holder: anonymous, seq: 9 });
    server.tick(10);
    linkEnds(watcher, { deliberate: false });
    // Before this phone's let-go reaches the server, a catch-up reads its hold back.
    await server.catchUp({ holder: anonymous, recent: [wallClimb(9), wallClimb(8)] });
    expect(effects.hapticWarning).not.toHaveBeenCalled();
    expect(getLetsGo()).toBeNull();
    advance(LETS_GO_TAKER_WAIT_MS);
    expect(getLetsGo()).toEqual({ kind: 'dropped' });
    expect(driveEndedCalls()[0]?.[1]).toMatchObject({ reason: 'link_dropped', takenBy: null });
  });

  it('never names a holder from before the drive when a catch-up reads them back', async () => {
    const sam: BoardConnectionHolder = { userId: 'user-sam', displayName: 'Sam' };
    // Sam lit the wall before this drive, and this phone's reports never moved the slot.
    const server = presenceServer({ holder: sam, recent: [wallClimb(12)] });
    const watcher = await mountOn(server.client);
    driveLive();
    server.tick(13);
    linkEnds(watcher, { deliberate: false });
    await server.catchUp({ holder: sam, recent: [wallClimb(12)] });
    expect(effects.hapticWarning).not.toHaveBeenCalled();
    advance(LETS_GO_TAKER_WAIT_MS);
    expect(getLetsGo()).toEqual({ kind: 'dropped' });
    expect(driveEndedCalls()[0]?.[1]).toMatchObject({ takenBy: null });
  });

  it('names a taker only a catch-up reveals', async () => {
    const server = presenceServer({ holder: null, recent: [wallClimb(4)] });
    const watcher = await mountOn(server.client);
    driveLive();
    server.emit({ __typename: 'BoardClimbSet', climb: wallClimb(5) });
    server.emit({ __typename: 'BoardConnectionChanged', holder: { userId: 'user-me', displayName: 'Me' }, seq: 5 });
    linkEnds(watcher, { deliberate: false });
    // Sam's take was lost with the socket; the reconnect reads it.
    await server.catchUp({
      holder: { userId: 'user-sam', displayName: 'Sam' },
      recent: [{ ...wallClimb(6), sentByUserId: 'user-sam' }, wallClimb(5), wallClimb(4)],
    });
    expect(getLetsGo()).toEqual({ kind: 'taken_named', name: 'Sam' });
    expect(driveEndedCalls()[0]?.[1]).toMatchObject({ takenBy: 'named' });
  });
});
