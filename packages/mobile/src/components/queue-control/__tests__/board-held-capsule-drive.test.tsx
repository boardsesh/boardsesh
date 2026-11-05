// @vitest-environment jsdom
// Owner, 2026-11-03: "Yes, every bulb". The Climbs header's You have the board
// pill (`BoardHeldCapsule`) lets go of the board on a tap; during any drive
// (Put on board's timed drive, an open-ended one, Always drive the wall's) the
// tap now stops driving and keeps the link instead. Its label stays the words
// on the pill (Voice Control says them); its hint says the tap stops driving.
// The real drive store and the real shared bulb hook (`useLightbulbControl`)
// run, so "no disconnect" is the Bluetooth context's own `disconnect` never
// being called. The pill's looks are board-held-capsule.test.tsx's.
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const signals = vi.hoisted(() => ({
  bluetooth: {
    isConnected: true,
    loading: false,
    disconnect: vi.fn(() => Promise.resolve()),
    connect: vi.fn(() => Promise.resolve(true)),
    releaseVirtualWall: vi.fn(),
    armUndoWallChangeToast: vi.fn(),
    lastLocalHolderUserId: null,
    reconnectSerialForCurrentBoard: 'serial-1',
    reconnectDeviceIdForCurrentBoard: null,
    boardName: 'kilter',
  },
  board: {
    localConnected: true,
    ledless: false,
    wallHeldLocally: false,
    inAppBoardConnection: 'connectedByMe' as 'connectedByMe' | 'heldByPeer' | 'disconnected',
  },
  currentClimb: null as null | { uuid: string; name: string; difficulty: string },
  driveEnded: vi.fn(),
  wallControlTapped: vi.fn(),
  hapticLight: vi.fn(),
  hapticMedium: vi.fn(),
  announceQueued: vi.fn(),
}));

vi.mock('../../../lib/analytics-wall-control', () => ({
  trackDriveModeStarted: vi.fn(),
  trackDriveModeEnded: signals.driveEnded,
  trackWallControlTapped: signals.wallControlTapped,
}));
vi.mock('../../../lib/analytics-board-connect', () => ({ trackBoardConnectTapped: vi.fn() }));
vi.mock('../../../providers/bluetooth-provider', () => ({ useOptionalBluetoothContext: () => null }));
vi.mock('../../ble/use-crew-holder-unconfirmed', () => ({ useCrewHolderUnconfirmed: () => false }));
vi.mock('../../../lib/boards/climb-board-connect-context', () => ({ useClimbBoardConnect: () => null }));
vi.mock('../../ble/use-board-connection-state', () => ({
  useBoardConnectionState: () => ({
    bluetooth: signals.bluetooth,
    lit: true,
    localConnected: signals.board.localConnected,
    pending: false,
    ledless: signals.board.ledless,
    wallHeldLocally: signals.board.wallHeldLocally,
    holderIsAuthoritative: false,
    inAppBoardConnection: signals.board.inAppBoardConnection,
    holderDisplayName: null,
  }),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key} ${JSON.stringify(params)}` : key),
  }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    colorScheme: 'dark',
    systemColors: { label: '#111111' },
    brandColors: { warning: '#FBBF24', primary: '#6D28D9' },
  }),
}));
vi.mock('../../../providers/ble-control-sheet-provider', () => ({ useBleControlSheet: () => ({ open: vi.fn() }) }));
vi.mock('../../../lib/haptics', () => ({ hapticLight: signals.hapticLight, hapticMedium: signals.hapticMedium }));
vi.mock('../../../lib/announce-queued', () => ({ announceQueued: signals.announceQueued }));
vi.mock('../../../providers/queue/queue-contexts', () => ({
  useQueueData: () => ({
    currentClimbQueueItem: signals.currentClimb ? { uuid: 'item-1', climb: signals.currentClimb } : null,
  }),
}));
vi.mock('../../chrome/use-settled-header-value', () => ({ useSettledHeaderValue: <T,>(value: T) => value }));
vi.mock('../../../providers/drawer-host-provider', () => ({ useDrawerHost: () => ({ boardConfig: null }) }));
vi.mock('../../../hooks/use-display-grade', () => ({
  useDisplayGrade: () => ({ resolveGrade: (climb: { difficulty: string }) => ({ label: climb.difficulty }) }),
}));
vi.mock('../../../lib/graphql/hooks', () => ({ useProfile: () => ({ data: null }) }));
vi.mock('../use-climb-wall-glow', () => ({ useClimbWallGlow: () => null }));
vi.mock('../../play-drawer/use-wall-glow', () => ({ useWallGlowLayer: () => null, wallGlowBlendFor: () => ({}) }));
vi.mock('../../play-drawer/WallGlow', () => ({ WallGlow: () => null }));
vi.mock('../../../theme/colors', () => ({
  wallGlowSurfaces: { dark: { label: '#fff', base: '#000', border: '#111' }, light: { label: '#000' } },
}));
vi.mock('../../Avatar', () => ({ Avatar: () => null }));
vi.mock('../use-climb-byline', () => ({ useClimbStatsDetail: () => null }));
// The swipe-to-hide pan has its own suite; these drive tests only need the tap.
vi.mock('react-native-reanimated', () => ({ useReducedMotion: () => false }));
vi.mock('../use-wall-capsule-dismiss', () => ({
  useWallCapsuleDismiss: () => ({
    gesture: {},
    animatedStyle: {},
    onLayout: () => {},
    consumePanned: () => false,
    dismiss: () => {},
  }),
}));
vi.mock('../WallCapsuleSwipe', () => ({ WallCapsuleSwipe: ({ children }: { children?: unknown }) => children }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', {}, children),
}));
vi.mock('../../LargeContentViewer', () => ({
  LargeContentViewer: ({ children }: { children?: ReactNode }) => createElement('span', {}, children),
}));
// The pill's own capsule, as a plain button: its press, label and hint.
vi.mock('../HeaderStatusCapsule', () => ({
  useHeaderCapsuleCompact: () => false,
  HeaderCapsuleClimbLabel: () => null,
  HeaderStatusCapsule: ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityHint,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
    accessibilityHint?: string;
  }) =>
    createElement(
      'button',
      { type: 'button', onClick: onPress, 'aria-label': accessibilityLabel, 'data-hint': accessibilityHint },
      children,
    ),
}));

import { BoardHeldCapsule } from '../BoardHeldCapsule';
import { resetOwedDropForTests, useOwedDropAnnouncement } from '../bar-bulb-tap';
import {
  enterDriveMode,
  exitDriveMode,
  getDriveMode,
  getLastDriveModeExitReason,
  isDrivingStoppedForLink,
  markDriveLive,
  resetDriveModeForTests,
  startAlwaysDrive,
} from '../../play-drawer/drive-mode-store';
import { DISCONNECT_TAP_GUARD_MS, WINDOW_END_TAP_GRACE_MS } from '../../play-drawer/drive-tap-guards';
import { resetAllSettings, setSetting } from '../../../settings';

function startTapDrive(windowMs: number | null) {
  act(() => {
    enterDriveMode({
      startedBy: 'tap',
      sessionId: null,
      boardId: 7,
      windowMs,
      windowSetting: windowMs === null ? null : 'putOnBoardKeepsLighting',
    });
    markDriveLive();
  });
}

const DRIVES = [
  ["Put on board's timed drive (45 s)", () => startTapDrive(45_000), 'stop_window'],
  ['an open-ended swipe drive', () => startTapDrive(null), 'stop_driving'],
  [
    "Always drive the wall's drive",
    () => {
      act(() => {
        startAlwaysDrive({ sessionId: null, boardId: 7 });
      });
    },
    'stop_driving',
  ],
] as const;

// The bare pill, and the pill drawing your queue head.
const PILLS = [
  ['the bare pill', null, 'ble.barControl.youHaveBoard'],
  [
    'the pill with your climb',
    { uuid: 'climb-1', name: 'Crimp Line', difficulty: 'V7' },
    'ble.barControl.youHaveBoardWithClimb {"name":"Crimp Line","grade":"V7"}',
  ],
] as const;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetDriveModeForTests();
  signals.board = {
    localConnected: true,
    ledless: false,
    wallHeldLocally: false,
    inAppBoardConnection: 'connectedByMe',
  };
  signals.bluetooth.isConnected = true;
  for (const mock of [
    signals.bluetooth.disconnect,
    signals.bluetooth.connect,
    signals.bluetooth.releaseVirtualWall,
    signals.driveEnded,
    signals.wallControlTapped,
    signals.hapticLight,
    signals.hapticMedium,
    signals.announceQueued,
  ]) {
    mock.mockClear();
  }
});
afterEach(() => {
  cleanup();
  resetDriveModeForTests();
  resetAllSettings();
  resetOwedDropForTests();
  vi.useRealTimers();
});

describe.each(PILLS)("%s: the header's You have the board pill", (_pill, climb, label) => {
  const renderPill = () => {
    signals.currentClimb = climb;
    const view = render(createElement(BoardHeldCapsule, { ledless: signals.board.ledless }));
    return { ...view, pill: () => view.getByRole('button') };
  };

  it.each(DRIVES)('stops %s on a tap and keeps the link: no disconnect', (_drive, start, action) => {
    start();
    const view = renderPill();
    fireEvent.click(view.pill());
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('stopped');
    expect(isDrivingStoppedForLink()).toBe(true);
    expect(signals.bluetooth.disconnect).not.toHaveBeenCalled();
    expect(signals.driveEnded).toHaveBeenCalledOnce();
    expect(signals.driveEnded).toHaveBeenCalledWith(expect.objectContaining({ reason: 'stopped' }));
    expect(signals.hapticLight).toHaveBeenCalledOnce();
    expect(signals.announceQueued).toHaveBeenCalledWith('playView.wallControl.stoppedDriving');
    expect(signals.wallControlTapped).toHaveBeenCalledOnce();
    expect(signals.wallControlTapped).toHaveBeenCalledWith({ state: 'lit', action, control: 'header_pill' });
  });

  it.each(DRIVES)('keeps its words and says a tap stops %s; that it lets go once over', (_drive, start) => {
    start();
    const view = renderPill();
    expect(view.pill().getAttribute('aria-label')).toBe(label);
    expect(view.pill().getAttribute('data-hint')).toBe('playView.wallControl.stopDrivingHint');
    fireEvent.click(view.pill());
    expect(view.pill().getAttribute('aria-label')).toBe(label);
    expect(view.pill().getAttribute('data-hint')).toBe('ble.barControl.connectedHint');
  });

  it('hangs up with no drive, as before, and logs no Wall Control Tapped', () => {
    const view = renderPill();
    expect(view.pill().getAttribute('data-hint')).toBe('ble.barControl.connectedHint');
    fireEvent.click(view.pill());
    expect(signals.bluetooth.disconnect).toHaveBeenCalledOnce();
    expect(signals.announceQueued).not.toHaveBeenCalled();
    expect(signals.wallControlTapped).not.toHaveBeenCalled();
  });

  it('hangs up while a drive is still arming: nothing drives yet', () => {
    act(() => {
      enterDriveMode({ startedBy: 'tap', sessionId: null, boardId: 7, windowMs: 45_000 });
    });
    const view = renderPill();
    fireEvent.click(view.pill());
    expect(signals.bluetooth.disconnect).toHaveBeenCalledOnce();
  });

  it('drops the second tap of a double tap: one stop, never a hang-up', () => {
    startTapDrive(45_000);
    const view = renderPill();
    fireEvent.click(view.pill());
    act(() => {
      vi.advanceTimersByTime(DISCONNECT_TAP_GUARD_MS - 1);
    });
    fireEvent.click(view.pill());
    expect(signals.bluetooth.disconnect).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    fireEvent.click(view.pill());
    expect(signals.bluetooth.disconnect).toHaveBeenCalledOnce();
  });

  it('drops a tap that lands just after the timed drive ran out: it was aimed at the stop', () => {
    startTapDrive(45_000);
    const view = renderPill();
    act(() => {
      exitDriveMode('window_ended');
    });
    act(() => {
      vi.advanceTimersByTime(WINDOW_END_TAP_GRACE_MS - 1);
    });
    fireEvent.click(view.pill());
    expect(signals.bluetooth.disconnect).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    fireEvent.click(view.pill());
    expect(signals.bluetooth.disconnect).toHaveBeenCalledOnce();
  });

  // Disconnect Bluetooth when driving ends: the stop lets go of the board too
  // (DriveModeWatcher), and a screen reader hears it once the link drops. The
  // pill shows only while this phone holds the board, so it usually goes in
  // the same render as the drop: the Climbs header says it then
  // (`useOwedDropAnnouncement`), as `ClimbTopChrome` mounts it.
  const dropLink = () => {
    signals.board = {
      localConnected: false,
      ledless: false,
      wallHeldLocally: false,
      inAppBoardConnection: 'disconnected',
    };
    signals.bluetooth.isConnected = false;
  };
  function Header({ linked, keepPill }: { linked: boolean; keepPill: boolean }) {
    useOwedDropAnnouncement(linked);
    if (!linked && !keepPill) return null;
    // A fresh prop each render: the settled header redraws the pill as the link drops.
    return createElement(BoardHeldCapsule, {
      ledless: false,
      dismiss: { occurrenceKey: `occ-${String(linked)}`, onDismiss: vi.fn() },
    });
  }
  const renderHeader = (keepPill: boolean) => {
    signals.currentClimb = climb;
    const view = render(createElement(Header, { linked: true, keepPill }));
    return {
      ...view,
      pill: () => view.getByRole('button'),
      drop: () => {
        dropLink();
        view.rerender(createElement(Header, { linked: false, keepPill }));
      },
    };
  };

  it.each([
    ['the pill goes with the hold', false],
    ['the settled header still draws the pill', true],
  ] as const)(
    'says Board disconnected once the link drops after a stop, with Disconnect Bluetooth when driving ends on: %s',
    (_case, keepPill) => {
      setSetting('disconnectWhenDrivingEnds', true);
      startTapDrive(null);
      const view = renderHeader(keepPill);
      fireEvent.click(view.pill());
      expect(signals.announceQueued).toHaveBeenLastCalledWith('playView.wallControl.stoppedDriving');
      // Not at the tap: a disconnect that never comes says nothing.
      expect(signals.announceQueued).not.toHaveBeenCalledWith('ble.barControl.disconnectedLabel');
      view.drop();
      expect(signals.announceQueued).toHaveBeenLastCalledWith('ble.barControl.disconnectedLabel');
      // Once: the stop's line and the drop's.
      expect(signals.announceQueued).toHaveBeenCalledTimes(2);
    },
  );

  it('says nothing more when the link drops later with the setting off', () => {
    startTapDrive(null);
    const view = renderHeader(false);
    fireEvent.click(view.pill());
    signals.announceQueued.mockClear();
    view.drop();
    expect(signals.announceQueued).not.toHaveBeenCalled();
  });

  it('says nothing for a drop no stop asked for: a hang-up with no drive', () => {
    setSetting('disconnectWhenDrivingEnds', true);
    const view = renderHeader(false);
    fireEvent.click(view.pill());
    expect(signals.bluetooth.disconnect).toHaveBeenCalledOnce();
    view.drop();
    expect(signals.announceQueued).not.toHaveBeenCalled();
  });

  // The owed drop is said once, and only for the link the stop let go of.
  const relinkSignals = () => {
    signals.board = {
      localConnected: true,
      ledless: false,
      wallHeldLocally: false,
      inAppBoardConnection: 'connectedByMe',
    };
    signals.bluetooth.isConnected = true;
  };
  // A stop on a pill that goes while the link is still up: the drop it owes is
  // left for the header.
  const stopThenLeave = () => {
    setSetting('disconnectWhenDrivingEnds', true);
    startTapDrive(null);
    signals.currentClimb = climb;
    const pill = render(createElement(BoardHeldCapsule, { ledless: false }));
    fireEvent.click(pill.getByRole('button'));
    pill.unmount();
  };
  const renderLinkedHeader = () => {
    signals.currentClimb = climb;
    const view = render(createElement(Header, { linked: true, keepPill: false }));
    return {
      drop: () => {
        dropLink();
        view.rerender(createElement(Header, { linked: false, keepPill: false }));
      },
    };
  };

  it('says the owed drop once: a header that comes back for a later drop says nothing', () => {
    setSetting('disconnectWhenDrivingEnds', true);
    startTapDrive(null);
    const first = renderHeader(false);
    fireEvent.click(first.pill());
    first.drop();
    expect(signals.announceQueued).toHaveBeenLastCalledWith('ble.barControl.disconnectedLabel');
    first.unmount();
    // Relinked while no header or bulb was there to see it.
    relinkSignals();
    signals.announceQueued.mockClear();
    renderLinkedHeader().drop();
    expect(signals.announceQueued).not.toHaveBeenCalled();
  });

  it('forgets an owed drop the header missed once it sees the link come back', () => {
    stopThenLeave();
    // The drop came while no header was there.
    dropLink();
    const view = render(createElement(Header, { linked: false, keepPill: false }));
    relinkSignals();
    view.rerender(createElement(Header, { linked: true, keepPill: false }));
    signals.announceQueued.mockClear();
    dropLink();
    view.rerender(createElement(Header, { linked: false, keepPill: false }));
    expect(signals.announceQueued).not.toHaveBeenCalled();
  });

  it('forgets an owed drop the header missed once any bulb sees the link come back', () => {
    stopThenLeave();
    // The drop came while no header was there; a bulb saw the link come back.
    dropLink();
    // A fresh prop each render: the capsule is memoised.
    const bulbAt = (key: string) =>
      createElement(BoardHeldCapsule, { ledless: false, dismiss: { occurrenceKey: key, onDismiss: vi.fn() } });
    const bulb = render(bulbAt('unlinked'));
    relinkSignals();
    bulb.rerender(bulbAt('relinked'));
    bulb.unmount();
    signals.announceQueued.mockClear();
    renderLinkedHeader().drop();
    expect(signals.announceQueued).not.toHaveBeenCalled();
  });

  it('still says an owed drop the header was not there for, when it is there for the drop', () => {
    stopThenLeave();
    signals.announceQueued.mockClear();
    renderLinkedHeader().drop();
    expect(signals.announceQueued).toHaveBeenCalledOnce();
    expect(signals.announceQueued).toHaveBeenCalledWith('ble.barControl.disconnectedLabel');
  });
});

describe('a held wall with no lights', () => {
  it('releases the wall on a tap, as before: no drive to stop there', () => {
    signals.board = {
      localConnected: false,
      ledless: true,
      wallHeldLocally: true,
      inAppBoardConnection: 'connectedByMe',
    };
    signals.bluetooth.isConnected = false;
    signals.currentClimb = null;
    startTapDrive(null);
    const view = render(createElement(BoardHeldCapsule, { ledless: true }));
    const pill = view.getByRole('button');
    expect(pill.getAttribute('data-hint')).toBe('ble.barControl.wallHeldHint');
    fireEvent.click(pill);
    expect(signals.bluetooth.releaseVirtualWall).toHaveBeenCalledOnce();
    expect(signals.wallControlTapped).not.toHaveBeenCalled();
  });
});
