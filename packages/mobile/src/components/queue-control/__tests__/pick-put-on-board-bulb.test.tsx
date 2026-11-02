// @vitest-environment jsdom
// Owner decision A: the MiniPlayer's bulb on the climber's last pick. No extra
// marking: lit, it is the bar's usual bulb; not lit, it reads off and a tap
// puts the pick on the board through the player's wall button path.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';

const state = vi.hoisted(() => ({
  wallUuid: null as string | null,
  bluetooth: {} as object | null,
  ledless: false,
  openPlayDrawer: vi.fn(),
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityHint,
    testID,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
    accessibilityHint?: string;
    testID?: string;
  }) =>
    createElement(
      'button',
      {
        type: 'button',
        onClick: onPress,
        'aria-label': accessibilityLabel,
        'data-hint': accessibilityHint,
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
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ openPlayDrawer: state.openPlayDrawer }),
}));
vi.mock('../../ble/use-board-connection-state', () => ({
  useBoardConnectionState: () => ({ bluetooth: state.bluetooth, ledless: state.ledless }),
}));
vi.mock('../../play-drawer/use-wall-climb', () => ({
  useWallClimb: () => ({ uuid: state.wallUuid, name: null, sentAt: null }),
}));

import { PickBulbSlot } from '../PickPutOnBoardBulb';
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

function renderSlot() {
  return render(
    createElement(PickBulbSlot, {
      pick: storedPick(),
      litBulb: createElement('span', { 'data-testid': 'usual-bulb' }),
      solidGlyphs: true,
    }),
  );
}

beforeEach(() => {
  resetLastPickForTests();
  state.wallUuid = null;
  state.bluetooth = {};
  state.ledless = false;
  state.openPlayDrawer.mockClear();
});
afterEach(() => cleanup());

describe('PickBulbSlot', () => {
  it('reads off on a pick that isn’t lit, and puts it on the board through the player', () => {
    const view = renderSlot();
    expect(view.queryByTestId('usual-bulb')).toBeNull();
    const bulb = view.getByTestId('mini-player-pick-put-on-board');
    expect(bulb.getAttribute('aria-label')).toBe('playView.wallControl.putOnBoard');
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

  it('is the bar’s usual bulb while the wall shows the pick', () => {
    state.wallUuid = 'pick';
    const view = renderSlot();
    expect(view.getByTestId('usual-bulb')).toBeTruthy();
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
