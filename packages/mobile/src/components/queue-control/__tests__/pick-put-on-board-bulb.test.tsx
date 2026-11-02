// @vitest-environment jsdom
// Owner decision A: the MiniPlayer's bulb on the climber's last pick. No extra
// marking: lit, it is the bar's usual bulb; not lit, it reads off and a tap
// puts the pick on the board through the player's wall button path. What the
// bulb is (`resolvePickBulb`) has its own suite in use-pick-bulb.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';

const state = vi.hoisted(() => ({
  bluetooth: {} as object | null,
  ledless: false,
  localConnected: false,
  inAppBoardConnection: 'disconnected' as 'connectedByMe' | 'heldByPeer' | 'disconnected',
  openPlayDrawer: vi.fn(),
  openBoardControls: vi.fn(),
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
vi.mock('../../../lib/haptics', () => ({ hapticMedium: vi.fn() }));

import { PickBulbSlot } from '../PickPutOnBoardBulb';
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
  state.bluetooth = {};
  state.ledless = false;
  state.localConnected = false;
  state.inAppBoardConnection = 'disconnected';
  state.openPlayDrawer.mockClear();
  state.openBoardControls.mockClear();
});
afterEach(() => cleanup());

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
