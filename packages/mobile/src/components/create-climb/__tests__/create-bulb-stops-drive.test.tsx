// @vitest-environment jsdom
// Owner, 2026-11-03: "Yes, every bulb". The create-climb editor's lightbulb
// connects (lighting the draft) or hangs up; while this phone drives the wall
// (a timed drive still running, an open-ended one, Always drive the wall's)
// a tap now stops driving and keeps the link instead, and the bulb says
// "Stop driving". The real drive store runs; `onToggle` is the editor's own
// connect/disconnect (`handleToggleBle`), so "no disconnect" is it never called.
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const signals = vi.hoisted(() => ({
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
vi.mock('../../ble/use-board-connection-state', () => ({
  useBoardConnectionState: () => ({
    localConnected: signals.board.localConnected,
    ledless: signals.board.ledless,
    inAppBoardConnection: signals.board.inAppBoardConnection,
  }),
}));
vi.mock('react-native', () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../lib/haptics', () => ({
  hapticSelection: vi.fn(),
  hapticLight: signals.hapticLight,
  hapticMedium: signals.hapticMedium,
}));
vi.mock('../../../lib/announce-queued', () => ({ announceQueued: signals.announceQueued }));
vi.mock('../../PressableSurface', () => ({ PressableSurface: () => null }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../Text', () => ({ Text: () => null }));
vi.mock('../../drawer-action-bar/DrawerActionBar', () => ({
  ActionButton: () => null,
  SIZES: { lg: { dim: 56, icon: 28 }, sm: { dim: 44, icon: 22 } },
  drawerActionBarStyles: { container: {}, rowSecondary: {}, spacer: {} },
}));
vi.mock('../../ble/BleLightbulbButton', () => ({
  BleLightbulbButton: ({
    onPress,
    accessibilityLabel,
    accessibilityTapHint,
    haptic,
  }: {
    onPress: () => void;
    accessibilityLabel: string;
    accessibilityTapHint?: string;
    haptic?: string;
  }) =>
    createElement('button', {
      type: 'button',
      onClick: onPress,
      'aria-label': accessibilityLabel,
      'data-hint': accessibilityTapHint,
      'data-own-haptic': haptic,
    }),
}));
vi.mock('../brush-roles', () => ({
  brushRoleColor: () => '#00FF00',
  getPaintRoles: () => [],
  useBrushRoleLabels: () => ({}),
}));
vi.mock('../CreateDraftStatusRow', () => ({ CreateDraftStatusRow: () => null, statusRowStyles: {} }));
vi.mock('../use-rate-limited-announcer', () => ({ useRateLimitedAnnouncer: () => vi.fn() }));
vi.mock('../../../lib/hold-color-overrides', () => ({ useHoldColorOverrides: () => ({ overrides: {} }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { label: '#000' }, brandColors: { warning: '#B45309', primary: '#A78BFA' } }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16 }, borderRadius: { md: 8 } }));

import { CreateDrawerActionBar } from '../CreateDrawerActionBar';
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

const onToggle = vi.fn();

function barProps(connected: boolean) {
  return {
    boardName: 'kilter' as const,
    selectedBrush: 'HAND' as const,
    onSelectBrush: vi.fn(),
    canUndo: false,
    canRedo: false,
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onClearHolds: vi.fn(),
    frameCount: 1,
    frameDeletions: 0,
    currentFrameIndex: 0,
    canSetActive: false,
    onSetActive: vi.fn(),
    draftStatus: null,
    lightbulb: { connected, connecting: false, onToggle },
  };
}

function renderBulb() {
  const connected = signals.board.localConnected;
  const view = render(createElement(CreateDrawerActionBar, barProps(connected)));
  return {
    ...view,
    bulb: () => view.getByRole('button'),
    linkDrops: () => {
      signals.board = { localConnected: false, ledless: false, inAppBoardConnection: 'disconnected' };
      view.rerender(createElement(CreateDrawerActionBar, barProps(false)));
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetDriveModeForTests();
  signals.board = { localConnected: true, ledless: false, inAppBoardConnection: 'connectedByMe' };
  for (const mock of [
    onToggle,
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

describe("the create-climb editor's lightbulb", () => {
  it.each(DRIVES)('stops %s on a tap and keeps the link: no disconnect', (_drive, start, action) => {
    start();
    const view = renderBulb();
    fireEvent.click(view.bulb());
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('stopped');
    expect(isDrivingStoppedForLink()).toBe(true);
    expect(onToggle).not.toHaveBeenCalled();
    expect(signals.driveEnded).toHaveBeenCalledOnce();
    expect(signals.driveEnded).toHaveBeenCalledWith(expect.objectContaining({ reason: 'stopped' }));
    // The stop's light buzz, never the toggle's medium one.
    expect(signals.hapticLight).toHaveBeenCalledOnce();
    expect(signals.hapticMedium).not.toHaveBeenCalled();
    expect(signals.announceQueued).toHaveBeenCalledWith('playView.wallControl.stoppedDriving');
    expect(signals.wallControlTapped).toHaveBeenCalledOnce();
    expect(signals.wallControlTapped).toHaveBeenCalledWith({ state: 'lit', action, control: 'create_climb' });
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

  it('runs its own toggle with no drive, with its medium buzz, as before', () => {
    const view = renderBulb();
    expect(view.bulb().getAttribute('aria-label')).toBe('lightControl.disconnect');
    // The bulb's own buzz is the press handler's now, so a stop buzzes once.
    expect(view.bulb().getAttribute('data-own-haptic')).toBe('none');
    fireEvent.click(view.bulb());
    expect(onToggle).toHaveBeenCalledOnce();
    expect(signals.hapticMedium).toHaveBeenCalledOnce();
    expect(signals.wallControlTapped).not.toHaveBeenCalled();
  });

  it('connects with no link, as before', () => {
    signals.board = { localConnected: false, ledless: false, inAppBoardConnection: 'disconnected' };
    const view = renderBulb();
    expect(view.bulb().getAttribute('aria-label')).toBe('ble.connectBoard');
    fireEvent.click(view.bulb());
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('runs its toggle while a drive is still arming: nothing drives yet', () => {
    act(() => {
      enterDriveMode({ startedBy: 'tap', sessionId: null, boardId: 7, windowMs: 45_000 });
    });
    const view = renderBulb();
    fireEvent.click(view.bulb());
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('drops the second tap of a double tap: one stop, never a hang-up', () => {
    startTapDrive(45_000);
    const view = renderBulb();
    fireEvent.click(view.bulb());
    act(() => {
      vi.advanceTimersByTime(DISCONNECT_TAP_GUARD_MS - 1);
    });
    fireEvent.click(view.bulb());
    expect(onToggle).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    fireEvent.click(view.bulb());
    expect(onToggle).toHaveBeenCalledOnce();
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
    expect(onToggle).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    fireEvent.click(view.bulb());
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('says Board disconnected once the link drops after a stop, with Disconnect Bluetooth when driving ends on', () => {
    setSetting('disconnectWhenDrivingEnds', true);
    startTapDrive(null);
    const view = renderBulb();
    fireEvent.click(view.bulb());
    expect(signals.announceQueued).toHaveBeenLastCalledWith('playView.wallControl.stoppedDriving');
    expect(signals.announceQueued).not.toHaveBeenCalledWith('ble.barControl.disconnectedLabel');
    view.linkDrops();
    expect(signals.announceQueued).toHaveBeenLastCalledWith('ble.barControl.disconnectedLabel');
    expect(signals.announceQueued).toHaveBeenCalledTimes(2);
  });

  it('says nothing more when the link drops later with the setting off', () => {
    startTapDrive(null);
    const view = renderBulb();
    fireEvent.click(view.bulb());
    signals.announceQueued.mockClear();
    view.linkDrops();
    expect(signals.announceQueued).not.toHaveBeenCalled();
  });
});
