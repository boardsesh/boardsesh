// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/queue';
import type { BoardConfig } from '../../../providers/drawer-host-provider';
import type { MiniPlayerButtonId } from '../../../lib/mini-player-buttons';

const host = vi.hoisted(() => ({
  openQueueSheet: vi.fn(),
  openAnglePicker: vi.fn(),
}));
const favorite = vi.hoisted(() => ({
  serverFavorited: undefined as boolean | undefined,
  statusArgs: [] as unknown[],
  mutate: vi.fn(),
}));
const share = vi.hoisted(() => ({ handleShare: vi.fn(), args: null as unknown }));
const navigation = vi.hoisted(() => ({
  canPrevious: true,
  canNext: false,
  onPrevious: vi.fn(),
  onNext: vi.fn(),
  playerOpen: false,
}));
const effects = vi.hoisted(() => ({ track: vi.fn(), hapticSelection: vi.fn(), showToast: vi.fn() }));
const bluetooth = vi.hoisted(() => ({
  isConnected: true,
  getMirrorIntent: vi.fn((_climbUuid: string | undefined): boolean | undefined => undefined),
  setMirrorIntent: vi.fn(),
  retainMirrorIntentFor: vi.fn(),
}));
const queue = vi.hoisted(() => ({
  sessionId: null as string | null,
  currentClimbQueueItem: null as { uuid: string; climb: { uuid: string; mirrored?: boolean | null } } | null,
  mirrorCurrentClimb: vi.fn(async () => true),
}));

vi.mock('react-native', () => ({
  StyleSheet: { create: <Styles,>(styles: Styles) => styles },
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { angle?: number }) => (options?.angle != null ? `${key}:${options.angle}` : key),
  }),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
    accessibilityState,
  }: {
    children?: ReactNode;
    onPress: () => void;
    disabled?: boolean;
    accessibilityLabel: string;
    accessibilityState?: { selected?: boolean };
  }) =>
    createElement(
      'button',
      {
        'aria-label': accessibilityLabel,
        'aria-pressed': accessibilityState?.selected,
        disabled,
        onClick: onPress,
      },
      children,
    ),
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name, color }: { name: string; color?: string }) =>
    createElement('i', { 'data-icon': name, 'data-icon-color': color ?? '' }),
}));
vi.mock('../../play-drawer/AnglePill', () => ({
  AnglePill: ({
    angle,
    onPress,
    accessibilityLabel,
  }: {
    angle: number;
    onPress: () => void;
    accessibilityLabel: string;
  }) => createElement('button', { 'aria-label': accessibilityLabel, onClick: onPress }, `${angle}°`),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { label: '#000' },
    actionColors: { favoriteSelected: '#E11D48' },
    brandColors: { primary: '#6D28D9' },
  }),
}));
vi.mock('../../../theme/tokens', () => ({ opacity: { disabled: 0.4 } }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: effects.showToast }) }));
vi.mock('../../../providers/bluetooth-provider', () => ({
  useOptionalBluetoothContext: () => bluetooth,
}));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueSessionId: () => ({ sessionId: queue.sessionId }),
  useQueueData: () => ({ currentClimbQueueItem: queue.currentClimbQueueItem }),
  useQueueActions: () => ({ mirrorCurrentClimb: queue.mirrorCurrentClimb }),
}));
vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ openQueueSheet: host.openQueueSheet, openAnglePicker: host.openAnglePicker }),
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useFavoriteStatus: (...args: unknown[]) => {
    favorite.statusArgs = args;
    return { data: favorite.serverFavorited };
  },
  useToggleFavorite: () => ({ mutate: favorite.mutate }),
}));
vi.mock('../../../hooks/use-share-climb-action', () => ({
  useShareClimbAction: (args: unknown) => {
    share.args = args;
    return share.handleShare;
  },
}));
vi.mock('../../../lib/analytics', () => ({ track: effects.track }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: effects.hapticSelection }));
vi.mock('expo-router', () => ({ useSegments: () => [] }));
vi.mock('../../../lib/route-segments', () => ({ isPlayerRoute: () => navigation.playerOpen }));
vi.mock('../use-mini-player-navigation', () => ({
  useMiniPlayerNavigation: () => navigation,
  MiniPlayerTrackPager: () => createElement('span', { 'data-track-pager': true }),
}));

import { MiniPlayerLeadingButtons } from '../MiniPlayerButtons';
import { __resetWallMirrorFlipForTests, getWallMirrorFlip, setWallMirrorFlip } from '../../../lib/wall-mirror-store';

const climb = {
  uuid: 'climb-a',
  name: 'Climb A',
  frames: 'p1r12',
  setter_username: 'setter',
  angle: 40,
  ascensionist_count: 3,
  difficulty: 'V4',
  quality_average: '3',
  stars: 3,
  difficulty_error: '0',
  benchmark_difficulty: null,
} as Climb;
const board: BoardConfig = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 };

type RenderOptions = {
  climbBoard?: BoardConfig | null;
  angle?: number | null;
  /** `null`: a climb drawn on another board. */
  angleClimbUuid?: string | null;
  /** The climb the bar shows. */
  shownClimb?: Climb;
};

function renderButtons(
  buttonIds: readonly MiniPlayerButtonId[],
  { climbBoard = board, angle = 40, angleClimbUuid = 'climb-a', shownClimb = climb }: RenderOptions = {},
) {
  return render(
    createElement(MiniPlayerLeadingButtons, {
      buttonIds,
      climb: shownClimb,
      climbBoard,
      angle,
      angleClimbUuid: angleClimbUuid ?? undefined,
      bluetoothConnected: true,
      slotWidth: 44,
      rowHeight: 52,
      groupGap: 12,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  favorite.serverFavorited = undefined;
  navigation.canPrevious = true;
  navigation.canNext = false;
  navigation.playerOpen = false;
  bluetooth.getMirrorIntent.mockImplementation(() => undefined);
  queue.sessionId = null;
  queue.currentClimbQueueItem = { uuid: 'item-a', climb };
  __resetWallMirrorFlipForTests();
});

describe('MiniPlayerLeadingButtons', () => {
  it('draws one slot per button, in the order it was given', () => {
    const { container } = renderButtons(['favorite', 'queue', 'previous', 'next']);
    const slots = Array.from(container.querySelectorAll('[data-testid^="mini-player-slot-"]')).map((slot) =>
      slot.getAttribute('data-testid'),
    );
    expect(slots).toEqual([
      'mini-player-slot-favorite',
      'mini-player-slot-queue',
      'mini-player-slot-previous',
      'mini-player-slot-next',
    ]);
  });

  describe('Favorite', () => {
    it('reads the heart for the climb on its own board and angle', () => {
      renderButtons(['favorite']);
      expect(favorite.statusArgs).toEqual(['kilter', 'climb-a', 40]);
    });

    it('adds a favourite through the shared toggle, from the server state', () => {
      favorite.serverFavorited = false;
      const { getByLabelText } = renderButtons(['favorite']);
      fireEvent.click(getByLabelText('playView.actionBar.addFavoriteAria'));
      // The toggle tracks the tap, in the direction it really goes.
      expect(favorite.mutate).toHaveBeenCalledWith(
        {
          input: { boardName: 'kilter', climbUuid: 'climb-a', angle: 40 },
          currentlyFavorited: false,
          tracking: { source: 'mini_player', layoutId: 1, connected: true },
        },
        expect.objectContaining({ onError: expect.any(Function) }),
      );
      expect(effects.hapticSelection).toHaveBeenCalledOnce();
      expect(effects.track).not.toHaveBeenCalled();
    });

    it('shows a favourite filled and removes it on a tap', () => {
      favorite.serverFavorited = true;
      const { getByLabelText, container } = renderButtons(['favorite']);
      expect(container.querySelector('[data-icon="favorite.fill"]')?.getAttribute('data-icon-color')).toBe('#E11D48');
      fireEvent.click(getByLabelText('playView.actionBar.removeFavoriteAria'));
      expect(favorite.mutate.mock.calls[0][0]).toMatchObject({ currentlyFavorited: true });
    });

    it('says so when the toggle fails', () => {
      const { getByLabelText } = renderButtons(['favorite']);
      fireEvent.click(getByLabelText('playView.actionBar.addFavoriteAria'));
      favorite.mutate.mock.calls[0][1].onError();
      expect(effects.showToast).toHaveBeenCalledWith('playView.favoriteError', 'error');
    });

    it('waits for a board before drawing a heart', () => {
      const { container } = renderButtons(['favorite'], { climbBoard: null });
      expect(container.querySelector('button')).toBeNull();
    });
  });

  it('Queue opens the queue sheet', () => {
    const { getByLabelText } = renderButtons(['queue']);
    fireEvent.click(getByLabelText('mobile.queueSnackbar.openAria'));
    expect(host.openQueueSheet).toHaveBeenCalledOnce();
  });

  it("Share runs the player's share action for this climb and board, tagged as the MiniPlayer's", () => {
    const { getByLabelText } = renderButtons(['share']);
    expect(share.args).toEqual({
      climb,
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,20',
      angle: 40,
      source: 'mini_player',
    });
    fireEvent.click(getByLabelText('mobile.climbRow.share'));
    expect(share.handleShare).toHaveBeenCalledOnce();
  });

  describe('Angle', () => {
    it("shows the player's angle and opens the host's angle sheet for this climb", () => {
      const { getByLabelText } = renderButtons(['angle'], { angle: 55 });
      const pill = getByLabelText('mobile.angleSelector.buttonAria:55');
      expect(pill.textContent).toBe('55°');
      fireEvent.click(pill);
      expect(host.openAnglePicker).toHaveBeenCalledWith('climb-a');
    });

    it('asks for no per-angle grades for a climb drawn on another board', () => {
      const { getByLabelText } = renderButtons(['angle'], { angleClimbUuid: null });
      fireEvent.click(getByLabelText('mobile.angleSelector.buttonAria:40'));
      expect(host.openAnglePicker).toHaveBeenCalledWith(undefined);
    });

    it('draws nothing on a fixed-angle board', () => {
      const { container } = renderButtons(['angle'], { angle: null });
      expect(container.querySelector('button')).toBeNull();
    });
  });

  describe('⏮ ⏭', () => {
    it('walk the queue, and read disabled where there is nothing to move to', () => {
      const { getByLabelText } = renderButtons(['previous', 'next']);
      fireEvent.click(getByLabelText('playView.actionBar.previousAria'));
      expect(navigation.onPrevious).toHaveBeenCalledOnce();
      const next = getByLabelText('playView.actionBar.nextAria') as HTMLButtonElement;
      expect(next.disabled).toBe(true);
    });

    it('page the list only while Next shows and the player is closed', () => {
      expect(renderButtons(['next']).container.querySelector('[data-track-pager]')).not.toBeNull();
      expect(renderButtons(['previous']).container.querySelector('[data-track-pager]')).toBeNull();
      navigation.playerOpen = true;
      expect(renderButtons(['next']).container.querySelector('[data-track-pager]')).toBeNull();
    });
  });

  describe('Mirror', () => {
    const tension: BoardConfig = { boardName: 'tension', layoutId: 10, sizeId: 1, setIds: '1,2', angle: 40 };
    const mirrorButton = (container: HTMLElement) =>
      container.querySelector('[data-testid="mini-player-slot-mirror"] button') as HTMLButtonElement | null;

    it('solo, flips the wall: the shared flip the player reads, and the BLE intent', () => {
      const { container, getByLabelText } = renderButtons(['mirror'], { climbBoard: tension });
      expect(mirrorButton(container)?.getAttribute('aria-pressed')).toBe('false');
      fireEvent.click(getByLabelText('playView.actionBar.mirrorAria'));
      expect(getWallMirrorFlip()).toEqual({ climbUuid: 'climb-a', mirrored: true });
      expect(bluetooth.setMirrorIntent).toHaveBeenCalledWith('climb-a', true);
      expect(queue.mirrorCurrentClimb).not.toHaveBeenCalled();
      expect(effects.track).toHaveBeenCalledWith(
        'Mirror Climb',
        expect.objectContaining({ climbUuid: 'climb-a', isMirrored: true, surface: 'mini_player', shared: false }),
      );
      // Selected now, and the next tap turns it back.
      expect(mirrorButton(container)?.getAttribute('aria-pressed')).toBe('true');
      expect(container.querySelector('[data-icon="mirror"]')?.getAttribute('data-icon-color')).toBe('#6D28D9');
      fireEvent.click(getByLabelText('playView.actionBar.unmirrorAria'));
      expect(getWallMirrorFlip()).toEqual({ climbUuid: 'climb-a', mirrored: false });
      expect(bluetooth.setMirrorIntent).toHaveBeenLastCalledWith('climb-a', false);
    });

    it("shows a flip the player made, and only on that flip's climb", () => {
      setWallMirrorFlip(null, 'climb-a', true);
      expect(
        mirrorButton(renderButtons(['mirror'], { climbBoard: tension }).container)?.getAttribute('aria-pressed'),
      ).toBe('true');
      __resetWallMirrorFlipForTests();
      setWallMirrorFlip(null, 'climb-b', true);
      expect(
        mirrorButton(renderButtons(['mirror'], { climbBoard: tension }).container)?.getAttribute('aria-pressed'),
      ).toBe('false');
    });

    it("solo, starts from the climb's own orientation (a mirrored tick relit)", () => {
      const { container, getByLabelText } = renderButtons(['mirror'], {
        climbBoard: tension,
        shownClimb: { ...climb, mirrored: true },
      });
      expect(mirrorButton(container)?.getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(getByLabelText('playView.actionBar.unmirrorAria'));
      expect(bluetooth.setMirrorIntent).toHaveBeenCalledWith('climb-a', false);
    });

    it("in a session, flips the crew's climb and leaves the solo flip alone", () => {
      queue.sessionId = 'session-1';
      queue.currentClimbQueueItem = { uuid: 'item-a', climb: { ...climb, mirrored: true } };
      const { container, getByLabelText } = renderButtons(['mirror'], { climbBoard: tension });
      // The crew's orientation is the queue item's.
      expect(mirrorButton(container)?.getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(getByLabelText('playView.actionBar.unmirrorAria'));
      expect(queue.mirrorCurrentClimb).toHaveBeenCalledWith(false, 'item-a');
      expect(bluetooth.setMirrorIntent).not.toHaveBeenCalled();
      expect(getWallMirrorFlip()).toBeNull();
      expect(effects.track).toHaveBeenCalledWith('Mirror Climb', expect.objectContaining({ shared: true }));
    });

    it("in a session, does nothing while the bar still shows a climb that left the queue's head", () => {
      queue.sessionId = 'session-1';
      queue.currentClimbQueueItem = { uuid: 'item-b', climb: { uuid: 'climb-b' } };
      const { getByLabelText } = renderButtons(['mirror'], { climbBoard: tension });
      fireEvent.click(getByLabelText('playView.actionBar.mirrorAria'));
      expect(queue.mirrorCurrentClimb).not.toHaveBeenCalled();
      expect(bluetooth.setMirrorIntent).not.toHaveBeenCalled();
    });

    it('waits for a board', () => {
      const { container } = renderButtons(['mirror'], { climbBoard: null });
      expect(container.querySelector('button')).toBeNull();
    });
  });
});
