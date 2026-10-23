// @vitest-environment jsdom
vi.mock('../../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
import { render, fireEvent } from '@testing-library/react';
import { createElement, forwardRef, useImperativeHandle, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb, ClimbQueueItem } from '@boardsesh/queue';

// The queue sheet labels its sections (History, Up next, Suggestions), shows a
// header only when the section has rows, and puts a divider before Suggestions.

type ViewProps = { children?: ReactNode; testID?: string; style?: unknown };

// Mutable per-test: the board-scoped feed `useBoardContinuationFeed` hands back.
const feedFixture = vi.hoisted(() => ({ climbs: [] as Climb[] }));
const scrollToIndex = vi.hoisted(() => vi.fn());
const dragArgs = vi.hoisted(() => ({ calls: [] as Array<{ firstFutureRowIndex: number }> }));

vi.mock('react-native', () => ({
  useWindowDimensions: () => ({ fontScale: 1 }),
  View: ({ children, testID }: ViewProps) => createElement('div', { 'data-testid': testID }, children),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: ViewProps & { onPress?: () => void; accessibilityLabel?: string }) =>
    createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
  },
}));

vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetFlatList: forwardRef(function FlatListMock(
    {
      data,
      renderItem,
      keyExtractor,
    }: {
      data: unknown[];
      renderItem: (info: { item: unknown; index: number }) => ReactNode;
      keyExtractor: (item: unknown, index: number) => string;
    },
    ref,
  ) {
    useImperativeHandle(ref, () => ({ scrollToIndex }));
    return createElement(
      'div',
      null,
      data.map((item, index) => createElement('div', { key: keyExtractor(item, index) }, renderItem({ item, index }))),
    );
  }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({
    systemColors: { separator: '#ccc', secondaryBackground: '#fff' },
    brandColors: { primary: '#6D28D9' },
  }),
}));

vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 10: 40, 16: 64 },
}));
vi.mock('../../sheet-content-inset', () => ({ withSheetBottomInset: (style: unknown) => style }));
vi.mock('../use-queue-drag', () => ({
  useQueueDrag: (args: { firstFutureRowIndex: number }) => {
    dragArgs.calls.push(args);
    return {
      isDragging: false,
      controls: { shared: {}, onRowHeight: vi.fn(), makeHandleGesture: vi.fn() },
    };
  },
}));
vi.mock('../../SectionHeader', () => ({
  SectionHeader: ({ title }: { title: string }) => createElement('h2', null, title),
}));
vi.mock('../../Text', () => ({ Text: ({ children }: ViewProps) => createElement('span', null, children) }));
vi.mock('../../ClimbListItemContent', () => ({ ClimbListItemContent: () => createElement('span', null) }));
vi.mock('../../QueueItemRow', () => ({
  POSITION_SLOT_WIDTH: 28,
  QUEUE_ROW_LEADING_INSET: 52,
  QueueItemRow: ({ item }: { item: { uuid: string } }) => createElement('div', { 'data-testid': `row-${item.uuid}` }),
}));

// The board-scoped popular feed. Mocked directly (rather than the underlying
// `useSearchClimbs`) so each case controls exactly which climbs come back as
// FEED-provenance without touching GraphQL plumbing.
vi.mock('../../../providers/queue/use-board-continuation-feed', () => ({
  useBoardContinuationFeed: () => ({ climbs: feedFixture.climbs, isSettled: true }),
}));

vi.mock('../../../providers/queue-provider', () => ({
  useQueueSessionId: () => ({ sessionId: null }),
}));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isLoading: false }) }));

vi.mock('../../../providers/party-profile-provider', () => ({
  usePartyProfile: () => ({ profile: null, isLoading: false }),
}));

import { QueueList } from '../QueueList';

const board = { boardName: 'kilter' as const, layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 };

function climb(uuid: string): Climb {
  return { uuid, name: `Climb ${uuid}` } as Climb;
}

function item(uuid: string): ClimbQueueItem {
  return { uuid, climb: climb(`c-${uuid}`) } as unknown as ClimbQueueItem;
}

function renderQueue(
  queue: ClimbQueueItem[],
  currentItemUuid: string | null,
  showFullHistory = false,
  autoScrollOnMount = false,
) {
  return render(
    createElement(QueueList, {
      queue,
      currentItemUuid,
      board,
      isEditMode: false,
      showHistory: true,
      showFullHistory,
      selectedItems: new Set<string>(),
      playlistSuggestionSource: null,
      active: true,
      autoScrollOnMount,
      onToggleSelect: vi.fn(),
      onClimbPress: vi.fn(),
      onRemove: vi.fn(),
      onShowFullHistory: vi.fn(),
      onTickHistory: vi.fn(),
      onSuggestionPress: vi.fn(),
      reorderQueue: vi.fn(),
    }),
  );
}

const headings = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('h2')).map((node) => node.textContent);

describe('QueueList section headers', () => {
  beforeEach(() => {
    feedFixture.climbs = [];
  });

  it('labels History, Up next and Suggestions in order', () => {
    feedFixture.climbs = [climb('s1')];
    const queue = ['h1', 'cur', 'f1'].map(item);
    const { container } = renderQueue(queue, 'cur');
    expect(headings(container)).toEqual([
      'queueList.sectionHistory',
      'queueList.sectionUpNext',
      'queueList.sectionSuggestions',
    ]);
  });

  it('shows a header only when its section has rows', () => {
    const { container } = renderQueue([item('cur')], 'cur');
    expect(headings(container)).toEqual([]);
  });

  it('omits History when nothing has been climbed and Suggestions when there are none', () => {
    const { container } = renderQueue([item('cur'), item('f1')], 'cur');
    expect(headings(container)).toEqual(['queueList.sectionUpNext']);
  });

  it('labels Up next when there is no current climb', () => {
    const { container } = renderQueue([item('f1'), item('f2')], null);
    expect(headings(container)).toEqual(['queueList.sectionUpNext']);
  });

  it('shows the last 2 history rows and collapses the rest', () => {
    const queue = ['h1', 'h2', 'h3', 'h4', 'cur'].map(item);
    const { queryByTestId, getByText } = renderQueue(queue, 'cur');
    expect(queryByTestId('row-h1')).toBeNull();
    expect(queryByTestId('row-h2')).toBeNull();
    expect(queryByTestId('row-h3')).not.toBeNull();
    expect(queryByTestId('row-h4')).not.toBeNull();
    expect(getByText('queueList.showFullHistory')).toBeTruthy();
  });

  it('shows every history row when expanded', () => {
    const queue = ['h1', 'h2', 'h3', 'h4', 'cur'].map(item);
    const { queryByTestId } = renderQueue(queue, 'cur', true);
    expect(queryByTestId('row-h1')).not.toBeNull();
  });

  it('puts one divider before Suggestions and none before History or Up next', () => {
    feedFixture.climbs = [climb('s1')];
    const { container, queryAllByTestId } = renderQueue(['h1', 'cur', 'f1'].map(item), 'cur');
    const dividers = queryAllByTestId('queue-suggestions-divider');
    expect(dividers).toHaveLength(1);
    const nextHeading = dividers[0].parentElement?.querySelector('h2');
    expect(nextHeading?.textContent).toBe('queueList.sectionSuggestions');
    expect(container.querySelectorAll('[data-testid="queue-suggestions-divider"]')).toHaveLength(1);
  });

  it('has no divider without suggestions', () => {
    const { queryAllByTestId } = renderQueue(['h1', 'cur', 'f1'].map(item), 'cur');
    expect(queryAllByTestId('queue-suggestions-divider')).toHaveLength(0);
  });

  describe('row indices with headers', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      scrollToIndex.mockClear();
      dragArgs.calls = [];
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('scrolls to the current climb counting the History header', () => {
      // rows: [History header, h1, divider, cur, Up next header, f1] -> cur is row 3.
      renderQueue(['h1', 'cur', 'f1'].map(item), 'cur', false, true);
      vi.advanceTimersByTime(400);
      expect(scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 3 }));
    });

    it('points the drag window at the first upcoming climb after the headers', () => {
      // rows: [History header, h1, divider, cur, Up next header, f1] -> f1 is row 5.
      renderQueue(['h1', 'cur', 'f1'].map(item), 'cur');
      expect(dragArgs.calls.at(-1)?.firstFutureRowIndex).toBe(5);
    });
  });
});
