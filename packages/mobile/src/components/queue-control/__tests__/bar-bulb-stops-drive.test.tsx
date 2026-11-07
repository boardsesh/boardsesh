// @vitest-environment jsdom
// Owner, 2026-11-03 (2.7.0 TestFlight): "When I press the accessory bar
// lightbulb while I'm in the 45s driving period, we should only stop driving,
// not also immediately disconnect." The bar's bulb (`BoardControlIndicator`)
// now does what the player's frosted button and the Lock Screen bulb do: during
// any drive it shows, a tap stops driving and keeps the link. With no drive it
// hangs up or connects, as before. The real drive store and the real shared
// bulb hook (`useLightbulbControl`) run here, so "no disconnect" is the
// Bluetooth context's own `disconnect` never being called.
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const signals = vi.hoisted(() => ({
  bluetooth: {
    isConnected: true,
    loading: false,
    disconnect: vi.fn(() => Promise.resolve()),
    connect: vi.fn(() => Promise.resolve(true)),
    armUndoWallChangeToast: vi.fn(),
    lastLocalHolderUserId: null,
    reconnectSerialForCurrentBoard: 'serial-1',
    reconnectDeviceIdForCurrentBoard: null,
    boardName: 'kilter',
  },
  board: {
    localConnected: true,
    inAppBoardConnection: 'connectedByMe' as 'connectedByMe' | 'heldByPeer' | 'disconnected',
  },
  openPlay: vi.fn(),
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
    lit: signals.board.inAppBoardConnection !== 'disconnected',
    localConnected: signals.board.localConnected,
    pending: false,
    ledless: false,
    wallHeldLocally: false,
    holderIsAuthoritative: signals.board.inAppBoardConnection === 'heldByPeer',
    inAppBoardConnection: signals.board.inAppBoardConnection,
    holderDisplayName: null,
  }),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: Record<string, unknown>) => styles,
  },
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityHint,
    accessibilityValue,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
    accessibilityHint?: string;
    accessibilityValue?: { text?: string };
  }) =>
    createElement(
      'button',
      {
        type: 'button',
        onClick: onPress,
        'aria-label': accessibilityLabel,
        'data-hint': accessibilityHint,
        'data-value': accessibilityValue?.text,
      },
      children,
    ),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
// The ring draws itself from the drive store (board-control-indicator-drive.test.tsx).
vi.mock('../../play-drawer/WallWindowRing', () => ({ WallWindowRing: () => createElement('s', { 'data-ring': '' }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({
    systemColors: { secondaryLabel: '#8E8E93' },
    brandColors: { warning: '#FBBF24', live: '#FBBF24', primary: '#A78BFA', onAccent: '#16111F', onPrimary: '#FFF' },
    colorScheme: 'dark',
  }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/ble-control-sheet-provider', () => ({ useBleControlSheet: () => ({ open: vi.fn() }) }));
vi.mock('../use-accessory-climb-tap', () => ({ useAccessoryClimbTap: () => ({ openPlay: signals.openPlay }) }));
vi.mock('../../../hooks/use-differentiate-without-color', () => ({ useDifferentiateWithoutColor: () => 'off' }));
vi.mock('../../../lib/haptics', () => ({ hapticLight: signals.hapticLight, hapticMedium: signals.hapticMedium }));
vi.mock('../../../lib/announce-queued', () => ({ announceQueued: signals.announceQueued }));

import { BoardControlIndicator } from '../BoardControlIndicator';
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

// Each drive, and the stop Wall Control Tapped logs for it (as the tablet's bulb).
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

// Both bars draw this one component; only their props differ.
const BARS = [
  [
    'the iOS 26 accessory and the Material card (NativeAccessoryClimbRow)',
    { size: 44, iconSize: 22, enableLongPress: true, solidGlyphs: true, placement: 'regular' as const },
  ],
  ['the floating glass capsule (ClimbCapsule)', { size: 44, enableLongPress: true }],
] as const;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetDriveModeForTests();
  signals.board = { localConnected: true, inAppBoardConnection: 'connectedByMe' };
  signals.bluetooth.isConnected = true;
  for (const mock of [
    signals.bluetooth.disconnect,
    signals.bluetooth.connect,
    signals.openPlay,
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
  vi.useRealTimers();
});

describe.each(BARS)("%s: the bar's bulb", (_bar, props) => {
  const renderBulb = () => {
    const view = render(createElement(BoardControlIndicator, props));
    return { ...view, bulb: () => view.getByRole('button') };
  };

  it.each(DRIVES)('stops %s on a tap and keeps the link: no disconnect', (_drive, start, action) => {
    start();
    const view = renderBulb();
    fireEvent.click(view.bulb());
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('stopped');
    // Always drive the wall pauses until the link drops or the next Put on board.
    expect(isDrivingStoppedForLink()).toBe(true);
    expect(signals.bluetooth.disconnect).not.toHaveBeenCalled();
    expect(signals.bluetooth.connect).not.toHaveBeenCalled();
    expect(signals.openPlay).not.toHaveBeenCalled();
    // Drive Mode Ended, once, as the frosted button's stop.
    expect(signals.driveEnded).toHaveBeenCalledOnce();
    expect(signals.driveEnded).toHaveBeenCalledWith(expect.objectContaining({ reason: 'stopped' }));
    // A light buzz (nothing was let go), and a screen reader hears the stop.
    expect(signals.hapticLight).toHaveBeenCalledOnce();
    expect(signals.announceQueued).toHaveBeenCalledWith('playView.wallControl.stoppedDriving');
    // Wall Control Tapped, once, as the tablet's bar bulb logs its stop.
    expect(signals.wallControlTapped).toHaveBeenCalledOnce();
    expect(signals.wallControlTapped).toHaveBeenCalledWith({ state: 'lit', action, control: 'mini_bar' });
  });

  it('says "Stop driving" while a drive runs, and what it said before once it ends', () => {
    startTapDrive(45_000);
    const view = renderBulb();
    expect(view.bulb().getAttribute('aria-label')).toBe('ble.barControl.stopDrivingLabel');
    expect(view.bulb().getAttribute('data-hint')).toBe('ble.barControl.stopDrivingHint');
    expect(view.bulb().getAttribute('data-value')).toBe('ble.barControl.drivingValue');
    fireEvent.click(view.bulb());
    expect(view.bulb().getAttribute('aria-label')).toBe('ble.barControl.connectedLabel');
    expect(view.bulb().getAttribute('data-hint')).toBe('ble.barControl.connectedHint');
    expect(view.bulb().getAttribute('data-value')).toBeNull();
  });

  it('hangs up with no drive, as before', () => {
    const view = renderBulb();
    expect(view.bulb().getAttribute('aria-label')).toBe('ble.barControl.connectedLabel');
    expect(view.bulb().getAttribute('data-hint')).toBe('ble.barControl.connectedHint');
    fireEvent.click(view.bulb());
    expect(signals.bluetooth.disconnect).toHaveBeenCalledOnce();
    expect(signals.hapticLight).not.toHaveBeenCalled();
    expect(signals.announceQueued).not.toHaveBeenCalled();
    // Only a stop is a Wall Control Tapped from a phone's bar.
    expect(signals.wallControlTapped).not.toHaveBeenCalled();
  });

  it('hangs up while a drive is still arming: the bulb shows no drive yet', () => {
    act(() => {
      enterDriveMode({ startedBy: 'tap', sessionId: null, boardId: 7, windowMs: 45_000 });
    });
    const view = renderBulb();
    expect(view.bulb().getAttribute('aria-label')).toBe('ble.barControl.connectedLabel');
    fireEvent.click(view.bulb());
    expect(signals.bluetooth.disconnect).toHaveBeenCalledOnce();
  });

  it('connects with no link, as before', () => {
    signals.board = { localConnected: false, inAppBoardConnection: 'disconnected' };
    signals.bluetooth.isConnected = false;
    const view = renderBulb();
    fireEvent.click(view.bulb());
    expect(signals.bluetooth.connect).toHaveBeenCalledOnce();
    expect(signals.bluetooth.disconnect).not.toHaveBeenCalled();
  });

  it("opens the wall's climb on a crewmate's board, as before: their drive is not this bulb's to stop", () => {
    signals.board = { localConnected: false, inAppBoardConnection: 'heldByPeer' };
    signals.bluetooth.isConnected = false;
    startTapDrive(45_000);
    const view = renderBulb();
    fireEvent.click(view.bulb());
    expect(signals.openPlay).toHaveBeenCalledOnce();
    expect(getDriveMode()).not.toBeNull();
  });

  it('drops the second tap of a double tap: one stop, never a hang-up', () => {
    startTapDrive(45_000);
    const view = renderBulb();
    fireEvent.click(view.bulb());
    act(() => {
      vi.advanceTimersByTime(DISCONNECT_TAP_GUARD_MS - 1);
    });
    fireEvent.click(view.bulb());
    expect(signals.bluetooth.disconnect).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    // A deliberate tap after the guard hangs up, as before.
    fireEvent.click(view.bulb());
    expect(signals.bluetooth.disconnect).toHaveBeenCalledOnce();
  });

  it('drops a tap that lands just after the timed drive ran out: it was aimed at the stop', () => {
    startTapDrive(45_000);
    const view = renderBulb();
    act(() => {
      exitDriveMode('window_ended');
    });
    act(() => {
      vi.advanceTimersByTime(WINDOW_END_TAP_GRACE_MS - 1);
    });
    fireEvent.click(view.bulb());
    expect(signals.bluetooth.disconnect).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    fireEvent.click(view.bulb());
    expect(signals.bluetooth.disconnect).toHaveBeenCalledOnce();
  });
  // Disconnect Bluetooth when driving ends: the stop lets go of the board too
  // (DriveModeWatcher), so a screen reader hears it once the link drops, as
  // after the frosted button's stop.
  const linkDrops = (view: ReturnType<typeof renderBulb>) => {
    signals.board = { localConnected: false, inAppBoardConnection: 'disconnected' };
    signals.bluetooth.isConnected = false;
    view.rerender(createElement(BoardControlIndicator, props));
  };

  it('says Board disconnected once the link drops after a stop, with Disconnect Bluetooth when driving ends on', () => {
    setSetting('disconnectWhenDrivingEnds', true);
    startTapDrive(45_000);
    const view = renderBulb();
    fireEvent.click(view.bulb());
    expect(signals.announceQueued).toHaveBeenLastCalledWith('playView.wallControl.stoppedDriving');
    // Not at the tap: a disconnect that never comes says nothing.
    expect(signals.announceQueued).not.toHaveBeenCalledWith('ble.barControl.disconnectedLabel');
    linkDrops(view);
    expect(signals.announceQueued).toHaveBeenLastCalledWith('ble.barControl.disconnectedLabel');
    expect(signals.announceQueued).toHaveBeenCalledTimes(2);
  });

  it('says nothing more when the link drops later with the setting off', () => {
    startTapDrive(45_000);
    const view = renderBulb();
    fireEvent.click(view.bulb());
    signals.announceQueued.mockClear();
    linkDrops(view);
    expect(signals.announceQueued).not.toHaveBeenCalled();
  });
});
