// @vitest-environment jsdom
// Owner, 2026-11-03: "Yes, every bulb". Any lightbulb tapped during a drive
// (Put on board's timed drive, an open-ended one, Always drive the wall's)
// stops driving and keeps the link; with no drive the tap does what it did.
// Here the toolbar's bulb (the glass button on Climbs and Discover, and the
// shared hook the rail's native item draws) and the Android app bar's. The
// real drive store and the real shared bulb hook (`useLightbulbControl`) run,
// so "no disconnect" is the Bluetooth context's own `disconnect` never called.
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react';
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
    ledless: false,
    inAppBoardConnection: 'connectedByMe' as 'connectedByMe' | 'heldByPeer' | 'disconnected',
  },
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
    ledless: signals.board.ledless,
    wallHeldLocally: false,
    holderIsAuthoritative: signals.board.inAppBoardConnection === 'heldByPeer',
    inAppBoardConnection: signals.board.inAppBoardConnection,
    holderDisplayName: null,
  }),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { label: '#111' }, brandColors: { warning: '#FBBF24' } }),
}));
vi.mock('../../../providers/ble-control-sheet-provider', () => ({ useBleControlSheet: () => ({ open: vi.fn() }) }));
vi.mock('../../../lib/haptics', () => ({ hapticLight: signals.hapticLight, hapticMedium: signals.hapticMedium }));
vi.mock('../../../lib/announce-queued', () => ({ announceQueued: signals.announceQueued }));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../../Text', () => ({ Text: () => null }));
vi.mock('../../icon-map', () => ({
  iconMap: {
    'lightbulb.fill': { ios: 'lightbulb.fill', android: 'lightbulb-on' },
    lightbulb: { ios: 'lightbulb', android: 'lightbulb-outline' },
  },
}));
vi.mock('../../play-drawer/AngleSelectorSheet', () => ({ AngleSelectorSheet: () => null }));
vi.mock('../use-material-angle-control', () => ({ useMaterialAngleControl: () => ({}) }));

type BulbProps = {
  children?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
};
// The glass toolbar button and Paper's app-bar action, as plain buttons.
const bulbButton = ({ children, onPress, accessibilityLabel, accessibilityHint }: BulbProps) =>
  createElement(
    'button',
    { type: 'button', onClick: onPress, 'aria-label': accessibilityLabel, 'data-hint': accessibilityHint },
    children,
  );
vi.mock('../GlassActionToolbar', () => ({
  GlassToolbarAction: (props: BulbProps) => bulbButton(props),
  toolbarGlyphSize: (size: number) => size,
  useToolbarActionSize: () => 44,
}));
vi.mock('react-native-paper', () => ({ Appbar: { Action: (props: BulbProps) => bulbButton(props) } }));

import { LightbulbToolbarAction, useToolbarLightbulb } from '../LightbulbToolbarAction';
import { MaterialLightbulbAction } from '../MaterialBoardActions';
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

// Each drive, and the stop Wall Control Tapped logs for it.
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

// Each bulb, and the `control` its stop logs: Board Connect Tapped's surface.
const BULBS = [
  ['the toolbar bulb (Climbs and Discover, glass)', LightbulbToolbarAction, 'toolbar'],
  ['the Android app bar bulb', MaterialLightbulbAction, 'app_bar'],
] as const;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetDriveModeForTests();
  signals.board = { localConnected: true, ledless: false, inAppBoardConnection: 'connectedByMe' };
  signals.bluetooth.isConnected = true;
  for (const mock of [
    signals.bluetooth.disconnect,
    signals.bluetooth.connect,
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

describe.each(BULBS)('%s', (_bulb, Bulb, control) => {
  const renderBulb = () => {
    const view = render(createElement(Bulb));
    return { ...view, bulb: () => view.getByRole('button') };
  };

  it.each(DRIVES)('stops %s on a tap and keeps the link: no disconnect', (_drive, start, action) => {
    start();
    const view = renderBulb();
    fireEvent.click(view.bulb());
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('stopped');
    // Always drive the wall waits for the link to drop or the next Put on board.
    expect(isDrivingStoppedForLink()).toBe(true);
    expect(signals.bluetooth.disconnect).not.toHaveBeenCalled();
    expect(signals.bluetooth.connect).not.toHaveBeenCalled();
    expect(signals.driveEnded).toHaveBeenCalledOnce();
    expect(signals.driveEnded).toHaveBeenCalledWith(expect.objectContaining({ reason: 'stopped' }));
    // One light buzz (the stop's own), and a screen reader hears the stop.
    expect(signals.hapticLight).toHaveBeenCalledOnce();
    expect(signals.announceQueued).toHaveBeenCalledWith('playView.wallControl.stoppedDriving');
    expect(signals.wallControlTapped).toHaveBeenCalledOnce();
    expect(signals.wallControlTapped).toHaveBeenCalledWith({ state: 'lit', action, control });
  });

  it.each(DRIVES)('says "Stop driving" during %s, and Disconnect board once it is over', (_drive, start) => {
    start();
    const view = renderBulb();
    expect(view.bulb().getAttribute('aria-label')).toBe('ble.barControl.stopDrivingLabel');
    expect(view.bulb().getAttribute('data-hint')).toBe('ble.barControl.stopDrivingHint');
    fireEvent.click(view.bulb());
    expect(view.bulb().getAttribute('aria-label')).toBe('lightControl.disconnect');
    expect(view.bulb().getAttribute('data-hint')).toBeNull();
  });

  it('hangs up with no drive, as before, and logs no Wall Control Tapped', () => {
    const view = renderBulb();
    expect(view.bulb().getAttribute('aria-label')).toBe('lightControl.disconnect');
    expect(view.bulb().getAttribute('data-hint')).toBeNull();
    fireEvent.click(view.bulb());
    expect(signals.bluetooth.disconnect).toHaveBeenCalledOnce();
    expect(signals.hapticLight).toHaveBeenCalledOnce();
    expect(signals.announceQueued).not.toHaveBeenCalled();
    expect(signals.wallControlTapped).not.toHaveBeenCalled();
  });

  it('hangs up while a drive is still arming: nothing drives yet', () => {
    act(() => {
      enterDriveMode({ startedBy: 'tap', sessionId: null, boardId: 7, windowMs: 45_000 });
    });
    const view = renderBulb();
    expect(view.bulb().getAttribute('aria-label')).toBe('lightControl.disconnect');
    fireEvent.click(view.bulb());
    expect(signals.bluetooth.disconnect).toHaveBeenCalledOnce();
  });

  it('connects with no link, as before', () => {
    signals.board = { localConnected: false, ledless: false, inAppBoardConnection: 'disconnected' };
    signals.bluetooth.isConnected = false;
    const view = renderBulb();
    expect(view.bulb().getAttribute('aria-label')).toBe('ble.connectBoard');
    fireEvent.click(view.bulb());
    expect(signals.bluetooth.connect).toHaveBeenCalledOnce();
    expect(signals.bluetooth.disconnect).not.toHaveBeenCalled();
  });

  it("leaves a crewmate's drive alone: it is not this bulb's to stop", () => {
    signals.board = { localConnected: false, ledless: false, inAppBoardConnection: 'heldByPeer' };
    signals.bluetooth.isConnected = false;
    startTapDrive(45_000);
    const view = renderBulb();
    expect(view.bulb().getAttribute('aria-label')).toBe('ble.peerDrivingBoard');
    fireEvent.click(view.bulb());
    expect(getDriveMode()).not.toBeNull();
    expect(signals.wallControlTapped).not.toHaveBeenCalled();
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
  // (DriveModeWatcher), so a screen reader hears it once the link drops.
  const linkDrops = (view: ReturnType<typeof renderBulb>) => {
    signals.board = { localConnected: false, ledless: false, inAppBoardConnection: 'disconnected' };
    signals.bluetooth.isConnected = false;
    view.rerender(createElement(Bulb));
  };

  it('says Board disconnected once the link drops after a stop, with Disconnect Bluetooth when driving ends on', () => {
    setSetting('disconnectWhenDrivingEnds', true);
    startTapDrive(45_000);
    const view = renderBulb();
    fireEvent.click(view.bulb());
    expect(signals.announceQueued).toHaveBeenLastCalledWith('playView.wallControl.stoppedDriving');
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

// The rail's native bar item (`useLightbulbBarItem`) draws this hook's label
// and runs its tap, with no hint or hold of its own.
describe("the toolbar's shared hook (the rail's native bar item)", () => {
  it.each(DRIVES)('stops %s and says "Stop driving"; Disconnect board after', (_drive, start, action) => {
    start();
    const { result } = renderHook(() => useToolbarLightbulb());
    expect(result.current.accessibilityLabel).toBe('ble.barControl.stopDrivingLabel');
    act(() => result.current.handlePress());
    expect(getDriveMode()).toBeNull();
    expect(signals.bluetooth.disconnect).not.toHaveBeenCalled();
    expect(signals.wallControlTapped).toHaveBeenCalledWith({ state: 'lit', action, control: 'toolbar' });
    expect(result.current.accessibilityLabel).toBe('lightControl.disconnect');
  });

  it('says nothing of driving on a wall held with no link: nothing drives its LEDs', () => {
    signals.board = { localConnected: false, ledless: true, inAppBoardConnection: 'connectedByMe' };
    startTapDrive(null);
    const { result } = renderHook(() => useToolbarLightbulb());
    expect(result.current.accessibilityLabel).not.toBe('ble.barControl.stopDrivingLabel');
    act(() => result.current.handlePress());
    expect(signals.wallControlTapped).not.toHaveBeenCalled();
  });

  it("stops the drive on a wall-device board over this phone's live link, which writes its LEDs", () => {
    signals.board = { localConnected: true, ledless: true, inAppBoardConnection: 'connectedByMe' };
    startTapDrive(null);
    const { result } = renderHook(() => useToolbarLightbulb());
    expect(result.current.accessibilityLabel).toBe('ble.barControl.stopDrivingLabel');
  });
});
