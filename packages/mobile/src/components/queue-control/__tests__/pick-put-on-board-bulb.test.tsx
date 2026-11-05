// @vitest-environment jsdom
// Owner decision A: the MiniPlayer's bulb on the climber's last pick. No extra
// marking: lit, it is the bar's usual bulb; not lit, it reads off and a tap
// puts the pick on the board through the player's wall button path. What the
// bulb is (`resolvePickBulb`) has its own suite in use-pick-bulb.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';

const state = vi.hoisted(() => ({
  bluetooth: {} as object | null,
  ledless: false,
  localConnected: false,
  inAppBoardConnection: 'disconnected' as 'connectedByMe' | 'heldByPeer' | 'disconnected',
  openPlayDrawer: vi.fn(),
  openBoardControls: vi.fn(),
  hapticLight: vi.fn(),
  announceQueued: vi.fn(),
  driveEnded: vi.fn(),
  wallControlTapped: vi.fn(),
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    onLongPress,
    accessibilityLabel,
    accessibilityHint,
    accessibilityValue,
    testID,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    onLongPress?: () => void;
    accessibilityLabel?: string;
    accessibilityHint?: string;
    accessibilityValue?: { text?: string };
    testID?: string;
  }) =>
    createElement(
      'button',
      {
        type: 'button',
        onClick: onPress,
        onContextMenu: onLongPress,
        'aria-label': accessibilityLabel,
        'data-hint': accessibilityHint,
        'data-value': accessibilityValue?.text,
        'data-testid': testID,
      },
      children,
    ),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryLabel: '#888' },
    brandColors: { warning: '#FBBF24', primary: '#6D28D9' },
  }),
}));
vi.mock('../../../hooks/use-differentiate-without-color', () => ({ useDifferentiateWithoutColor: () => 'off' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { board?: string }) => (opts?.board ? `${key}:${opts.board}` : key),
  }),
}));
vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ openPlayDrawer: state.openPlayDrawer }),
}));
vi.mock('../../ble/use-board-connection-state', () => ({
  useBoardConnectionState: () => ({
    bluetooth: state.bluetooth,
    ledless: state.ledless,
    localConnected: state.localConnected,
    inAppBoardConnection: state.inAppBoardConnection,
    holderDisplayName: null,
  }),
}));
vi.mock('../../../providers/ble-control-sheet-provider', () => ({
  useBleControlSheet: () => ({ open: state.openBoardControls }),
}));
vi.mock('../../../lib/haptics', () => ({ hapticMedium: vi.fn(), hapticLight: state.hapticLight }));
vi.mock('../../../lib/announce-queued', () => ({ announceQueued: state.announceQueued }));
vi.mock('../../../lib/analytics-wall-control', () => ({
  trackDriveModeStarted: vi.fn(),
  trackDriveModeEnded: state.driveEnded,
  trackWallControlTapped: state.wallControlTapped,
}));
// The ring itself (drain, refill, Reduce Motion) has its own suites; here, which one the bulb asks for.
vi.mock('../../play-drawer/WallWindowRing', () => ({
  WallWindowRing: ({ kind = 'drain' }: { kind?: string }) => createElement('s', { 'data-ring': kind }),
}));

import { PickBulbSlot } from '../PickPutOnBoardBulb';
import {
  enterDriveMode,
  exitDriveMode,
  getDriveMode,
  getLastDriveModeExitReason,
  isDrivingStoppedForLink,
  makeDriveOpenEnded,
  markDriveLive,
  resetDriveModeForTests,
  startAlwaysDrive,
} from '../../play-drawer/drive-mode-store';
import { DISCONNECT_TAP_GUARD_MS, WINDOW_END_TAP_GRACE_MS } from '../../play-drawer/drive-tap-guards';
import type { PickBulb } from '../use-pick-bulb';
import { getLastPick, resetLastPickForTests, setLastPick } from '../../../lib/last-pick-store';

const pickItem: ClimbQueueItem = {
  uuid: 'queue-pick',
  climb: {
    uuid: 'pick',
    name: 'The Eyes',
    frames: '',
    setter_username: 'setter',
    angle: 40,
    ascensionist_count: 0,
    difficulty: 'V3',
    quality_average: '3',
    stars: 3,
    difficulty_error: '0.3',
    benchmark_difficulty: null,
  },
};
const track: PlaylistSuggestionSource = {
  playlistUuid: 'playlist',
  activatedClimbUuid: 'pick',
  boardKey: 'kilter:1',
  climbs: [pickItem.climb],
};

function storedPick() {
  setLastPick({
    item: pickItem,
    suggestionSource: track,
    commitOptions: undefined,
    mirrored: false,
    currentAtPick: 'queue-current',
    wallAtPick: 'wall-at-pick',
    pickedAt: 7,
  });
  return getLastPick()!;
}

function renderSlot(bulb: PickBulb = { kind: 'putOnBoard', gymBoardName: null }) {
  return render(
    createElement(PickBulbSlot, {
      pick: storedPick(),
      bulb,
      litBulb: createElement('span', { 'data-testid': 'usual-bulb' }),
      solidGlyphs: true,
      enableLongPress: true,
      placement: 'regular',
    }),
  );
}

beforeEach(() => {
  resetLastPickForTests();
  resetDriveModeForTests();
  state.bluetooth = {};
  state.ledless = false;
  state.localConnected = false;
  state.inAppBoardConnection = 'disconnected';
  state.openPlayDrawer.mockClear();
  state.openBoardControls.mockClear();
  state.hapticLight.mockClear();
  state.announceQueued.mockClear();
  state.driveEnded.mockClear();
  state.wallControlTapped.mockClear();
});
afterEach(() => {
  cleanup();
  resetDriveModeForTests();
});

function startDrive(windowMs: number | null) {
  act(() => {
    enterDriveMode({
      startedBy: 'tap',
      sessionId: null,
      boardId: null,
      windowMs,
      windowSetting: windowMs === null ? null : 'putOnBoardKeepsLighting',
    });
    markDriveLive();
  });
}

const ringOf = (view: ReturnType<typeof render>) =>
  view.container.querySelector('[data-ring]')?.getAttribute('data-ring') ?? null;
const valueOf = (view: ReturnType<typeof render>) =>
  view.getByTestId('mini-player-pick-put-on-board').getAttribute('data-value');

// Owner decision 2026-11-02: every MiniPlayer bulb shows how long the wall keeps
// lighting picks, the Live Activity's pattern. An unlit pick never gets the
// amber disc (that says lit), so an open-ended drive is a whole ring.
describe('PickBulbSlot while this phone drives the wall', () => {
  beforeEach(() => {
    state.localConnected = true;
    state.inAppBoardConnection = 'connectedByMe';
  });

  it("drains the timed drive's ring round the unlit pick and says Driving the wall", () => {
    startDrive(45_000);
    const view = renderSlot();
    expect(ringOf(view)).toBe('drain');
    expect(valueOf(view)).toBe('ble.barControl.connectedLabel, ble.barControl.drivingValue');
    // Still the off bulb: the pick itself isn't lit.
    expect(view.container.querySelector('[data-icon="lightbulb.fill"]')).not.toBeNull();
  });

  it('keeps the ring whole for an open-ended drive', () => {
    startDrive(45_000);
    act(() => {
      makeDriveOpenEnded();
    });
    const view = renderSlot();
    expect(ringOf(view)).toBe('whole');
    expect(valueOf(view)).toBe('ble.barControl.connectedLabel, ble.barControl.drivingValue');
  });

  it('draws nothing extra with nobody driving, while arming, or off this phone’s lit link', () => {
    const idle = renderSlot();
    expect(ringOf(idle)).toBeNull();
    expect(valueOf(idle)).toBe('ble.barControl.connectedLabel');
    idle.unmount();
    act(() => {
      enterDriveMode({
        startedBy: 'tap',
        sessionId: null,
        boardId: null,
        windowMs: 45_000,
        windowSetting: 'putOnBoardKeepsLighting',
      });
    });
    const arming = renderSlot();
    expect(ringOf(arming)).toBeNull();
    arming.unmount();
    act(() => {
      markDriveLive();
    });
    state.localConnected = false;
    const unlinked = renderSlot();
    expect(ringOf(unlinked)).toBeNull();
    unlinked.unmount();
    // A wall with no lights held with no link: nothing drives the LEDs.
    state.ledless = true;
    const noLights = renderSlot();
    expect(ringOf(noLights)).toBeNull();
    noLights.unmount();
    // A wall-device board over this phone's live link writes real LEDs: it rings.
    state.localConnected = true;
    const wallDeviceLinked = renderSlot();
    expect(ringOf(wallDeviceLinked)).not.toBeNull();
    wallDeviceLinked.unmount();
    state.ledless = false;
    state.inAppBoardConnection = 'heldByPeer';
    const crew = renderSlot();
    expect(ringOf(crew)).toBeNull();
  });

  it('takes the ring off when the drive ends, with the bulb still mounted', () => {
    startDrive(45_000);
    const view = renderSlot();
    expect(ringOf(view)).toBe('drain');
    act(() => {
      resetDriveModeForTests();
    });
    expect(ringOf(view)).toBeNull();
    expect(valueOf(view)).toBe('ble.barControl.connectedLabel');
  });
});

// Owner, 2026-11-03: a bar bulb's tap during a drive only stops driving. The
// unlit pick's bulb shows the drive (its ring), so a tap there stops it too,
// keeping the link, and never opens the player to put the pick up.
describe('PickBulbSlot tapped while this phone drives the wall', () => {
  beforeEach(() => {
    state.localConnected = true;
    state.inAppBoardConnection = 'connectedByMe';
  });

  it.each([
    ["Put on board's timed drive", () => startDrive(45_000), 'stop_window'],
    ['an open-ended drive', () => startDrive(null), 'stop_driving'],
    [
      "Always drive the wall's drive",
      () => {
        act(() => {
          startAlwaysDrive({ sessionId: null, boardId: null });
        });
      },
      'stop_driving',
    ],
  ] as const)('stops %s and keeps the link: no Put on board', (_drive, start, action) => {
    start();
    const view = renderSlot();
    const bulb = view.getByTestId('mini-player-pick-put-on-board');
    expect(bulb.getAttribute('aria-label')).toBe('ble.barControl.stopDrivingLabel');
    expect(bulb.getAttribute('data-hint')).toBe('ble.barControl.stopDrivingHint');
    fireEvent.click(bulb);
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('stopped');
    expect(isDrivingStoppedForLink()).toBe(true);
    expect(state.openPlayDrawer).not.toHaveBeenCalled();
    expect(state.driveEnded).toHaveBeenCalledWith(expect.objectContaining({ reason: 'stopped' }));
    expect(state.hapticLight).toHaveBeenCalledOnce();
    expect(state.announceQueued).toHaveBeenCalledWith('playView.wallControl.stoppedDriving');
    // Counted as the tablet's bar bulb counts its stop.
    expect(state.wallControlTapped).toHaveBeenCalledOnce();
    expect(state.wallControlTapped).toHaveBeenCalledWith({ state: 'lit', action, control: 'mini_bar' });
    // Not driving any more: the bulb is Put on board for the pick again.
    expect(bulb.getAttribute('aria-label')).toBe('playView.wallControl.putOnBoard');
    expect(bulb.getAttribute('data-hint')).toBe('playView.wallControl.pickLightHint');
  });

  it('puts the pick up while the drive is still arming: the bulb shows no drive yet', () => {
    act(() => {
      enterDriveMode({ startedBy: 'tap', sessionId: null, boardId: null, windowMs: 45_000 });
    });
    const view = renderSlot();
    fireEvent.click(view.getByTestId('mini-player-pick-put-on-board'));
    expect(state.openPlayDrawer).toHaveBeenCalledOnce();
    expect(getDriveMode()?.phase).toBe('arming');
    // The put-up is the player's to count (as `mini_bar`, once its press runs).
    expect(state.wallControlTapped).not.toHaveBeenCalled();
  });

  it('drops the second tap of a double tap: one stop, no Put on board and fresh drive', () => {
    vi.useFakeTimers();
    try {
      startDrive(45_000);
      const view = renderSlot();
      const bulb = view.getByTestId('mini-player-pick-put-on-board');
      fireEvent.click(bulb);
      act(() => {
        vi.advanceTimersByTime(DISCONNECT_TAP_GUARD_MS - 1);
      });
      fireEvent.click(bulb);
      expect(state.openPlayDrawer).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      fireEvent.click(bulb);
      expect(state.openPlayDrawer).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a tap that lands just after the timed drive ran out', () => {
    vi.useFakeTimers();
    try {
      startDrive(45_000);
      const view = renderSlot();
      act(() => {
        exitDriveMode('window_ended');
      });
      act(() => {
        vi.advanceTimersByTime(WINDOW_END_TAP_GRACE_MS - 1);
      });
      const bulb = view.getByTestId('mini-player-pick-put-on-board');
      fireEvent.click(bulb);
      expect(state.openPlayDrawer).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      fireEvent.click(bulb);
      expect(state.openPlayDrawer).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("puts the pick up on a crewmate's board: their drive is not this bulb's to stop", () => {
    startDrive(45_000);
    state.localConnected = false;
    state.inAppBoardConnection = 'heldByPeer';
    const view = renderSlot();
    fireEvent.click(view.getByTestId('mini-player-pick-put-on-board'));
    expect(state.openPlayDrawer).toHaveBeenCalledOnce();
    expect(getDriveMode()).not.toBeNull();
  });
});

describe('PickBulbSlot', () => {
  it('reads off on a pick that isn’t lit, and puts it on the board through the player', () => {
    const view = renderSlot();
    expect(view.queryByTestId('usual-bulb')).toBeNull();
    const bulb = view.getByTestId('mini-player-pick-put-on-board');
    expect(bulb.getAttribute('aria-label')).toBe('playView.wallControl.putOnBoard');
    // The tap opens the player first: the hint says so.
    expect(bulb.getAttribute('data-hint')).toBe('playView.wallControl.pickLightHint');
    expect(bulb.querySelector('[data-icon="lightbulb.fill"]')).not.toBeNull();
    fireEvent.click(bulb);
    // The player opens on the pick as the same preview and presses Put on
    // board there: the wall button's path (busy-wall question, timed drive).
    expect(state.openPlayDrawer).toHaveBeenCalledWith(pickItem.climb, {
      previewQueueItem: pickItem,
      playlistSuggestionSource: track,
      previewMirrored: false,
      previewLatchStart: { wallClimbUuid: 'wall-at-pick', at: 7 },
      putOnBoard: true,
    });
  });

  // The player's own words for a press that moves to another board at the gym.
  it('says Put on {board} for a pick on another board at this gym', () => {
    const view = renderSlot({ kind: 'putOnBoard', gymBoardName: 'MoonBoard' });
    const bulb = view.getByTestId('mini-player-pick-put-on-board');
    expect(bulb.getAttribute('aria-label')).toBe('playView.wallControl.putOnGymBoard:MoonBoard');
    expect(bulb.getAttribute('data-hint')).toBe('playView.wallControl.pickMoveToGymBoardHint:MoonBoard');
  });

  // The usual bulb speaks the board's connection; standing in its place, this
  // one keeps saying it, so the bar never goes quiet about the board.
  it('speaks the board connection as its value', () => {
    const off = renderSlot();
    expect(off.getByTestId('mini-player-pick-put-on-board').getAttribute('data-value')).toBe(
      'ble.barControl.disconnectedLabel',
    );
    off.unmount();
    state.localConnected = true;
    state.inAppBoardConnection = 'connectedByMe';
    const on = renderSlot();
    expect(on.getByTestId('mini-player-pick-put-on-board').getAttribute('data-value')).toBe(
      'ble.barControl.connectedLabel',
    );
  });

  it('opens the board controls on a long press, only over a real link', () => {
    const unlinked = renderSlot();
    fireEvent.contextMenu(unlinked.getByTestId('mini-player-pick-put-on-board'));
    expect(state.openBoardControls).not.toHaveBeenCalled();
    unlinked.unmount();
    state.localConnected = true;
    state.inAppBoardConnection = 'connectedByMe';
    const linked = renderSlot();
    fireEvent.contextMenu(linked.getByTestId('mini-player-pick-put-on-board'));
    expect(state.openBoardControls).toHaveBeenCalledWith({ surface: 'board_control_indicator', placement: 'regular' });
  });

  it('is the bar’s usual bulb while the wall shows the pick', () => {
    const view = renderSlot({ kind: 'lit' });
    expect(view.getByTestId('usual-bulb')).toBeTruthy();
    expect(view.queryByTestId('mini-player-pick-put-on-board')).toBeNull();
  });

  it('draws nothing for a pick no board here can light', () => {
    const view = renderSlot({ kind: 'none' });
    expect(view.queryByTestId('usual-bulb')).toBeNull();
    expect(view.queryByTestId('mini-player-pick-put-on-board')).toBeNull();
  });

  it('draws the pin, not a bulb, on a board with no lights', () => {
    state.ledless = true;
    const view = renderSlot();
    expect(view.getByTestId('mini-player-pick-put-on-board').querySelector('[data-icon="pin.fill"]')).not.toBeNull();
  });

  it('draws nothing with no board bound', () => {
    state.bluetooth = null;
    const view = renderSlot();
    expect(view.queryByTestId('mini-player-pick-put-on-board')).toBeNull();
  });
});
