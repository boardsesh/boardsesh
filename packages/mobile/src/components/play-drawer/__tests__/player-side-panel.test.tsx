// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, createRef, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Climb } from '@boardsesh/shared-schema';
import type { PlayerSidePanelClimb } from '../play-drawer-types';

// The landscape iPad player's panel keeps Up next mounted behind the other
// segments (its edit mode and Undo survive a look at the logbook) and mounts
// Logbook and Beta only while chosen.

const navigation = vi.hoisted(() => ({ push: vi.fn(), track: vi.fn() }));

type ChildProps = { children?: ReactNode };
vi.mock('react-native', () => ({
  View: ({ children, testID, style }: ChildProps & { testID?: string; style?: { display?: string } }) =>
    createElement('div', { 'data-testid': testID, 'data-hidden': String(style?.display === 'none') }, children),
  ScrollView: ({ children }: ChildProps) => createElement('div', { 'data-testid': 'panel-scroll' }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('expo-router', () => ({ router: { push: navigation.push } }));
vi.mock('@boardsesh/analytics', () => ({ SHARED_EVENTS: { BoardSwapTapped: 'Board Swap Tapped' } }));
vi.mock('../../../lib/analytics', () => ({ track: navigation.track }));
vi.mock('../../../providers/board-presence-provider', () => ({
  useBoardPresenceControls: () => ({ boardId: 42 }),
}));
vi.mock('../../Text', () => ({ Text: ({ children }: ChildProps) => createElement('span', null, children) }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 20, left: 0, right: 0 }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8, 3: 12, 4: 16, 16: 64 } }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { separator: '#ccc', secondaryLabel: '#888' } }),
}));
vi.mock('../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: { boardType: 'kilter', name: 'Garage Wall' } }),
}));
vi.mock('../../../lib/boards/active-board-label', () => ({
  formatActiveBoardLabel: (board: { name: string } | null) => board?.name ?? null,
}));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueData: () => ({ queue: [], currentClimbQueueItem: null, historyCount: 0 }),
}));
vi.mock('../../SegmentedControl', () => ({
  SegmentedControl: ({
    options,
    selectedKey,
    onSelect,
  }: {
    options: { key: string; label: string }[];
    selectedKey: string;
    onSelect: (key: string) => void;
  }) =>
    createElement(
      'div',
      { 'data-testid': 'segments', 'data-selected': selectedKey },
      ...options.map((option) =>
        createElement('button', { key: option.key, onClick: () => onSelect(option.key) }, option.label),
      ),
    ),
}));
vi.mock('../../board-presence/SwitchBoardFooter', () => ({
  SwitchBoardFooter: ({ boardLabel, onPress }: { boardLabel: string | null; onPress: () => void }) =>
    createElement('button', { onClick: onPress, 'data-label': boardLabel }, 'Switch board'),
}));
vi.mock('../QueueListBody', () => ({
  QueueListBody: ({ presentation, active, onClose }: { presentation: string; active: boolean; onClose?: () => void }) =>
    createElement('div', {
      'data-testid': 'queue-body',
      'data-presentation': presentation,
      'data-active': String(active),
      'data-closable': String(onClose != null),
    }),
}));
vi.mock('../LogbookSection', () => ({
  LogbookSection: ({ climbUuid, angle }: { climbUuid: string; angle: number }) =>
    createElement('div', { 'data-testid': 'logbook', 'data-climb': climbUuid, 'data-angle': String(angle) }),
}));
vi.mock('../BetaVideosSection', () => ({
  BetaVideosSection: ({ climbUuid }: { climbUuid: string }) =>
    createElement('div', { 'data-testid': 'beta', 'data-climb': climbUuid }),
}));

import { PlayerSidePanel, type PlayerSidePanelHandle } from '../PlayerSidePanel';

const queueBoard = { boardName: 'kilter' as const, layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 };
const displayed: PlayerSidePanelClimb = {
  climb: { uuid: 'climb-1', userAscents: 1, userAttempts: 3 } as Climb,
  boardName: 'kilter',
  layoutId: 1,
  angle: 40,
  onOpenFullLogbook: vi.fn(),
};

function renderPanel(
  overrides: { displayed?: PlayerSidePanelClimb | null; queueBoard?: typeof queueBoard | null } = {},
) {
  const ref = createRef<PlayerSidePanelHandle>();
  render(
    createElement(PlayerSidePanel, {
      ref,
      displayed,
      queueBoard,
      onClimbPress: vi.fn(),
      onOpenActions: vi.fn(),
      onSuggestionPress: vi.fn(),
      onTickHistory: vi.fn(),
      ...overrides,
    }),
  );
  return ref;
}

function tapSegment(key: string) {
  fireEvent.click(screen.getByRole('button', { name: `playView.sidePanel.${key}` }));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PlayerSidePanel', () => {
  it('opens on the live queue, with nothing to close', () => {
    renderPanel();
    expect(screen.getByTestId('segments').getAttribute('data-selected')).toBe('upNext');
    const body = screen.getByTestId('queue-body');
    expect(body.getAttribute('data-presentation')).toBe('panel');
    expect(body.getAttribute('data-active')).toBe('true');
    expect(body.getAttribute('data-closable')).toBe('false');
    expect(screen.queryByTestId('logbook')).toBeNull();
    expect(screen.queryByTestId('beta')).toBeNull();
  });

  it('keeps Up next mounted, paused, behind the logbook', () => {
    renderPanel();
    const body = screen.getByTestId('queue-body');
    tapSegment('logbook');
    // The same element: edit mode, selection and Undo live on.
    expect(screen.getByTestId('queue-body')).toBe(body);
    expect(body.getAttribute('data-active')).toBe('false');
    expect(body.parentElement?.getAttribute('data-hidden')).toBe('true');
    const logbook = screen.getByTestId('logbook');
    expect(logbook.getAttribute('data-climb')).toBe('climb-1');
    expect(logbook.getAttribute('data-angle')).toBe('40');
  });

  it('mounts the beta videos only on the Beta segment', () => {
    renderPanel();
    tapSegment('beta');
    expect(screen.getByTestId('beta').getAttribute('data-climb')).toBe('climb-1');
    expect(screen.queryByTestId('logbook')).toBeNull();
    tapSegment('upNext');
    expect(screen.queryByTestId('beta')).toBeNull();
  });

  it('comes back to Up next when the player asks', () => {
    const ref = renderPanel();
    tapSegment('logbook');
    act(() => ref.current?.showUpNext());
    expect(screen.getByTestId('segments').getAttribute('data-selected')).toBe('upNext');
    expect(screen.queryByTestId('logbook')).toBeNull();
  });

  it('waits for a climb before Logbook and Beta show anything', () => {
    renderPanel({ displayed: null });
    tapSegment('logbook');
    expect(screen.queryByTestId('logbook')).toBeNull();
    expect(screen.queryByTestId('panel-scroll')).toBeNull();
  });

  it('shows the empty queue line before a board resolves', () => {
    renderPanel({ queueBoard: null });
    expect(screen.queryByTestId('queue-body')).toBeNull();
    expect(screen.getByText('mobile.queueSheet.emptyQueue')).toBeTruthy();
  });

  it('tracks the tap and opens the picker so a pick returns to the player', () => {
    renderPanel();
    const footer = screen.getByRole('button', { name: 'Switch board' });
    expect(footer.getAttribute('data-label')).toBe('Garage Wall');
    fireEvent.click(footer);
    expect(navigation.track).toHaveBeenCalledWith('Board Swap Tapped', {
      boardId: 42,
      surface: 'player_side_panel',
    });
    expect(navigation.push).toHaveBeenCalledWith({ pathname: '/boards', params: { returnTo: '/play' } });
  });
});
