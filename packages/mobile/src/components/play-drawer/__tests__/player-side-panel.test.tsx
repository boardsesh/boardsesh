// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Climb } from '@boardsesh/shared-schema';
import type { PlayerSidePanelClimb } from '../play-drawer-types';

// The landscape iPad player's panel mounts only the chosen segment: the queue
// list and the beta fetch never run behind another segment.

type ChildProps = { children?: ReactNode };
vi.mock('react-native', () => ({
  View: ({ children, testID }: ChildProps & { testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  ScrollView: ({ children }: ChildProps) => createElement('div', { 'data-testid': 'panel-scroll' }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 20, left: 0, right: 0 }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8, 3: 12, 4: 16 } }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: { separator: '#ccc' } }) }));
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

import { PlayerSidePanel, type PlayerSidePanelSegment } from '../PlayerSidePanel';

const queueBoard = { boardName: 'kilter' as const, layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 };
const displayed: PlayerSidePanelClimb = {
  climb: { uuid: 'climb-1', userAscents: 1, userAttempts: 3 } as Climb,
  boardName: 'kilter',
  layoutId: 1,
  angle: 40,
  onOpenFullLogbook: vi.fn(),
};

function renderPanel(segment: PlayerSidePanelSegment, overrides: Partial<Parameters<typeof PlayerSidePanel>[0]> = {}) {
  const props = {
    displayed,
    segment,
    onSegmentChange: vi.fn(),
    queueBoard,
    onSwitchBoard: vi.fn(),
    onClimbPress: vi.fn(),
    onOpenActions: vi.fn(),
    onSuggestionPress: vi.fn(),
    onTickHistory: vi.fn(),
    ...overrides,
  };
  render(createElement(PlayerSidePanel, props));
  return props;
}

afterEach(cleanup);

describe('PlayerSidePanel', () => {
  it('shows the live queue on Up next, with nothing to close', () => {
    renderPanel('upNext');
    const body = screen.getByTestId('queue-body');
    expect(body.getAttribute('data-presentation')).toBe('panel');
    expect(body.getAttribute('data-active')).toBe('true');
    expect(body.getAttribute('data-closable')).toBe('false');
    expect(screen.queryByTestId('logbook')).toBeNull();
    expect(screen.queryByTestId('beta')).toBeNull();
  });

  it('shows the logbook for the climb on screen, at its angle', () => {
    renderPanel('logbook');
    const logbook = screen.getByTestId('logbook');
    expect(logbook.getAttribute('data-climb')).toBe('climb-1');
    expect(logbook.getAttribute('data-angle')).toBe('40');
    expect(screen.queryByTestId('queue-body')).toBeNull();
    expect(screen.queryByTestId('beta')).toBeNull();
  });

  it('mounts the beta videos only on the Beta segment', () => {
    renderPanel('beta');
    expect(screen.getByTestId('beta').getAttribute('data-climb')).toBe('climb-1');
    expect(screen.queryByTestId('logbook')).toBeNull();
  });

  it('waits for a climb before Logbook and Beta show anything', () => {
    renderPanel('logbook', { displayed: null });
    expect(screen.queryByTestId('logbook')).toBeNull();
    expect(screen.queryByTestId('panel-scroll')).toBeNull();
  });

  it('reports a segment tap and switches boards from the footer', () => {
    const props = renderPanel('upNext');
    expect(screen.getByTestId('segments').getAttribute('data-selected')).toBe('upNext');
    fireEvent.click(screen.getByRole('button', { name: 'playView.sidePanel.beta' }));
    expect(props.onSegmentChange).toHaveBeenCalledWith('beta');
    const footer = screen.getByRole('button', { name: 'Switch board' });
    expect(footer.getAttribute('data-label')).toBe('Garage Wall');
    fireEvent.click(footer);
    expect(props.onSwitchBoard).toHaveBeenCalledTimes(1);
  });
});
