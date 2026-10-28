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
vi.mock('../../../providers/queue-provider', () => ({
  useQueueSessionId: () => ({ sessionId: queue.sessionId }),
  useActiveClimbUuid: () => queue.currentClimbQueueItem?.climb.uuid ?? null,
  useQueueActions: () => ({
    mirrorCurrentClimb: queue.mirrorCurrentClimb,
    getQueueSnapshot: () => ({
      sessionId: queue.sessionId,
      queue: [],
      currentClimbQueueItem: queue.currentClimbQueueItem,
    }),
  }),
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
      queueItemUuid: 'item-a',
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
  queue.sessionId = null;
  queue.currentClimbQueueItem = { uuid: 'item-a', climb };
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

    it('solo, records the exact current occurrence and reads its saved selection', () => {
      const { getByLabelText } = renderButtons(['mirror'], { climbBoard: tension });
      fireEvent.click(getByLabelText('playView.actionBar.mirrorAria'));
      expect(queue.mirrorCurrentClimb).toHaveBeenCalledWith(true, 'item-a');
      expect(effects.track).toHaveBeenCalledWith(
        'Mirror Climb',
        expect.objectContaining({ shared: false, isMirrored: true }),
      );
      const saved = { ...climb, mirrored: true };
      queue.currentClimbQueueItem = { uuid: 'item-a', climb: saved };
      const rendered = renderButtons(['mirror'], { climbBoard: tension, shownClimb: saved });
      expect(mirrorButton(rendered.container)?.getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(rendered.getByLabelText('playView.actionBar.unmirrorAria'));
      expect(queue.mirrorCurrentClimb).toHaveBeenLastCalledWith(false, 'item-a');
    });

    it('toggles from the latest head orientation rather than a stale rendered flag', () => {
      const { getByLabelText } = renderButtons(['mirror'], { climbBoard: tension });
      queue.currentClimbQueueItem = { uuid: 'item-a', climb: { ...climb, mirrored: true } };
      fireEvent.click(getByLabelText('playView.actionBar.mirrorAria'));
      expect(queue.mirrorCurrentClimb).toHaveBeenCalledWith(false, 'item-a');
    });

    it('uses the same guarded mutation for a crew', () => {
      queue.sessionId = 'session-1';
      const mirrored = { ...climb, mirrored: true };
      queue.currentClimbQueueItem = { uuid: 'item-a', climb: mirrored };
      const rendered = renderButtons(['mirror'], { climbBoard: tension, shownClimb: mirrored });
      fireEvent.click(rendered.getByLabelText('playView.actionBar.unmirrorAria'));
      expect(queue.mirrorCurrentClimb).toHaveBeenCalledWith(false, 'item-a');
      expect(effects.track).toHaveBeenCalledWith('Mirror Climb', expect.objectContaining({ shared: true }));
    });

    it('rejects a retained occurrence when another copy of the same climb is current', () => {
      const rendered = renderButtons(['mirror'], { climbBoard: tension });
      queue.currentClimbQueueItem = { uuid: 'item-a-repeat', climb };
      fireEvent.click(rendered.getByLabelText('playView.actionBar.mirrorAria'));
      expect(queue.mirrorCurrentClimb).not.toHaveBeenCalled();
      expect(effects.track).not.toHaveBeenCalled();
    });

    it('does nothing when the current occurrence disappears', () => {
      const rendered = renderButtons(['mirror'], { climbBoard: tension });
      queue.currentClimbQueueItem = null;
      fireEvent.click(rendered.getByLabelText('playView.actionBar.mirrorAria'));
      expect(queue.mirrorCurrentClimb).not.toHaveBeenCalled();
    });

    it("never flips a crew's climb from a screenshot capture that picks its own climb", () => {
      const previousMode = process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
      const previousCommands = process.env.EXPO_PUBLIC_SCREENSHOT_CPP_COMMANDS;
      process.env.EXPO_PUBLIC_SCREENSHOT_MODE = '1';
      process.env.EXPO_PUBLIC_SCREENSHOT_CPP_COMMANDS = '{"hero-1":{"route":"/climbs?screenshotClimbId=real"}}';
      try {
        queue.sessionId = 'session-1';
        const { getByLabelText } = renderButtons(['mirror'], { climbBoard: tension });
        fireEvent.click(getByLabelText('playView.actionBar.mirrorAria'));
        expect(queue.mirrorCurrentClimb).not.toHaveBeenCalled();
      } finally {
        if (previousMode === undefined) delete process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
        else process.env.EXPO_PUBLIC_SCREENSHOT_MODE = previousMode;
        if (previousCommands === undefined) delete process.env.EXPO_PUBLIC_SCREENSHOT_CPP_COMMANDS;
        else process.env.EXPO_PUBLIC_SCREENSHOT_CPP_COMMANDS = previousCommands;
      }
    });

    it('waits for a board', () => {
      const { container } = renderButtons(['mirror'], { climbBoard: null });
      expect(container.querySelector('button')).toBeNull();
    });
  });
});
