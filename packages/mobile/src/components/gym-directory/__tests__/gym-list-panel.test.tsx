// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, forwardRef, type ReactNode, type Ref } from 'react';
import type { Gym } from '@boardsesh/shared-schema';
import type { GymListRow } from '../gym-list-rows';

type Children = { children?: ReactNode };
type PressProps = { children?: ReactNode; onPress?: () => void };

// The gesture hook owns reanimated/gesture-handler worklets; stub it so the panel
// test stays a pure composition test (the detent math is exercised separately).
const ensureVisible = vi.fn();
const snapTo = vi.fn();
const scrollToIndex = vi.fn();
vi.mock('../use-gym-panel-gesture', () => ({
  useGymPanelGesture: () => ({
    gesture: {},
    nativeGesture: {},
    panelAnimatedStyle: {},
    panelHeight: 600,
    scrollEnabled: false,
    settledDetent: 'medium',
    onListScroll: () => {},
    onHeaderLayout: () => {},
    snapTo,
    ensureVisible,
  }),
}));

vi.mock('react-native', () => ({
  View: ({ children }: Children) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: Children) => createElement('div', null, children) },
}));

vi.mock('react-native-gesture-handler', () => ({
  GestureDetector: ({ children }: Children) => createElement('div', null, children),
}));

// FlashList renders each row through renderItem so we can assert the panel wires
// the right component per kind.
vi.mock('@shopify/flash-list', () => ({
  FlashList: forwardRef(
    (
      {
        data,
        renderItem,
      }: { data: GymListRow[]; renderItem: (info: { item: GymListRow; index: number }) => ReactNode },
      ref: Ref<unknown>,
    ) => {
      if (ref && typeof ref === 'object') (ref as { current: unknown }).current = { scrollToIndex };
      return createElement(
        'div',
        { 'data-list': 'true' },
        data.map((item, index) => createElement('div', { key: item.key }, renderItem({ item, index }))),
      );
    },
  ),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));

vi.mock('../../Text', () => ({ Text: ({ children }: Children) => createElement('span', null, children) }));
vi.mock('../../Icon', () => ({ Icon: () => createElement('i', null) }));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-testid': 'spinner' }),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress }: PressProps) =>
    createElement('button', { onClick: onPress, type: 'button' }, children),
}));

vi.mock('../../../theme/variants/variant-tokens', () => ({
  applySectionCaption: (text: string) => ({ text, style: {} }),
}));

vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
  borderRadius: { lg: 12, xl: 16, full: 9999 },
  shadows: { lg: {}, sm: {} },
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      secondaryBackground: '#fff',
      separator: '#ccc',
      label: '#000',
      secondaryLabel: '#666',
      tertiaryLabel: '#999',
      background: '#fff',
    },
    brandColors: { primary: '#6D28D9' },
    sheet: { handleStyle: {}, corners: null },
    sectionCaption: { uppercase: true, opacity: 0.6, letterSpacing: 0.5 },
  }),
}));

vi.mock('@boardsesh/board-config', () => ({
  formatBoardDisplayName: (boardType: string) => boardType.charAt(0).toUpperCase() + boardType.slice(1),
}));

import { GymListPanel } from '../GymListPanel';

const gym = {
  uuid: 'g1',
  name: 'Movement',
  address: '1 Crag St',
  boardCount: 1,
  boardTypes: ['kilter', 'tension'],
} as unknown as Gym;

function makeData(): GymListRow[] {
  return [
    { kind: 'sectionHeader', key: 'sh:gyms', label: 'GYMS' },
    { kind: 'gym', key: 'gym:g1', gym, subtitle: '1 Crag St', expanded: false, selected: false, boards: [] },
  ];
}

const claimableGym = {
  uuid: 'g2',
  name: 'Blackheath Boulders',
  address: '2 Boulder Rd',
  boardCount: 0,
  boardTypes: [],
  canClaim: true,
} as unknown as Gym;

function makeExpandedClaimData(): GymListRow[] {
  return [
    {
      kind: 'gym',
      key: 'gym:g2',
      gym: claimableGym,
      subtitle: '2 Boulder Rd',
      expanded: true,
      selected: false,
      boards: [],
    },
  ];
}

beforeEach(() => {
  ensureVisible.mockClear();
  snapTo.mockClear();
  scrollToIndex.mockClear();
});

describe('GymListPanel', () => {
  it('renders the pinned search slot and the gym rows', () => {
    const { getByTestId, getByText } = render(
      <GymListPanel
        data={makeData()}
        mapAvailable
        onPressGym={vi.fn()}
        onActivateBoard={vi.fn()}
        onEditGym={vi.fn()}
        onEditBoard={vi.fn()}
        noBoardsLabel="No boards yet"
        searchSlot={<div data-testid="search">search</div>}
      />,
    );
    expect(getByTestId('search')).toBeTruthy();
    expect(getByText('Movement')).toBeTruthy();
    expect(getByText('1 Crag St')).toBeTruthy();
    // Board-type badges render from Gym.boardTypes.
    expect(getByText('Kilter · Tension')).toBeTruthy();
  });

  it('invokes onPressGym with the gym when its row is tapped', () => {
    const onPressGym = vi.fn();
    const { getAllByRole } = render(
      <GymListPanel
        data={makeData()}
        mapAvailable
        onPressGym={onPressGym}
        onActivateBoard={vi.fn()}
        onEditGym={vi.fn()}
        onEditBoard={vi.fn()}
        noBoardsLabel="No boards yet"
        searchSlot={<div>search</div>}
      />,
    );
    // The only pressable in this data set is the gym row.
    fireEvent.click(getAllByRole('button')[0]);
    expect(onPressGym).toHaveBeenCalledWith(gym);
  });

  it('renders a claim action inside an expanded claimable row and calls onClaimGym', () => {
    const onClaimGym = vi.fn();
    const { getAllByRole } = render(
      <GymListPanel
        data={makeExpandedClaimData()}
        mapAvailable
        onPressGym={vi.fn()}
        onActivateBoard={vi.fn()}
        onEditGym={vi.fn()}
        onEditBoard={vi.fn()}
        onClaimGym={onClaimGym}
        noBoardsLabel="No boards yet"
        searchSlot={<div>search</div>}
      />,
    );
    // The expanded, claimable, board-less row yields two pressables: the gym
    // header (index 0) and the claim action (index 1).
    const buttons = getAllByRole('button');
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]);
    expect(onClaimGym).toHaveBeenCalledWith(claimableGym);
  });

  it('does not render a claim action when no onClaimGym handler is supplied', () => {
    const { getAllByRole } = render(
      <GymListPanel
        data={makeExpandedClaimData()}
        mapAvailable
        onPressGym={vi.fn()}
        onActivateBoard={vi.fn()}
        onEditGym={vi.fn()}
        onEditBoard={vi.fn()}
        noBoardsLabel="No boards yet"
        searchSlot={<div>search</div>}
      />,
    );
    // Only the gym header row is pressable without a claim handler.
    expect(getAllByRole('button')).toHaveLength(1);
  });

  it('shows the location prompt in place of the list before a location resolves', () => {
    const { getByTestId, queryByText } = render(
      <GymListPanel
        data={makeData()}
        mapAvailable
        onPressGym={vi.fn()}
        onActivateBoard={vi.fn()}
        onEditGym={vi.fn()}
        onEditBoard={vi.fn()}
        noBoardsLabel="No boards yet"
        searchSlot={<div>search</div>}
        locationPrompt={<div data-testid="loc-prompt">grant location</div>}
      />,
    );
    expect(getByTestId('loc-prompt')).toBeTruthy();
    // The list (and its gym rows) is not rendered while the prompt is shown.
    expect(queryByText('Movement')).toBeNull();
  });
});
