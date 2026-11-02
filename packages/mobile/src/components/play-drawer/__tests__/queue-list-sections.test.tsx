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
import { render } from '@testing-library/react';
import { createElement, forwardRef, useImperativeHandle, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb, ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import type { QueueWalkBoard } from '@boardsesh/play-view';

// The queue sheet labels its sections (History, Now, Up next, then below the
// queue "Then from <list>" and "Popular on this board"), shows a header only
// when the section has rows, and puts one divider between the queue and the
// climbs below it (Then-signposts, 2026-11-02).

type ViewProps = { children?: ReactNode; testID?: string; style?: unknown };

// Mutable per-test: the board-scoped feed `useBoardContinuationFeed` hands back.
const feedFixture = vi.hoisted(() => ({ climbs: [] as Climb[] }));
const scrollToIndex = vi.hoisted(() => vi.fn());
const dragArgs = vi.hoisted(() => ({ calls: [] as Array<{ firstFutureRowIndex: number }> }));

vi.mock('react-native', async () => ({
  // The side panel's plain list renders like the sheet's.
  FlatList: (await import('@expo/ui/community/bottom-sheet')).BottomSheetFlatList,
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

// The list name rides along so a test can see which list a header names.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { list?: string }) => (options?.list ? `${key}(${options.list})` : key),
  }),
}));

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
  presentation: 'sheet' | 'panel' = 'sheet',
  playlistSuggestionSource: PlaylistSuggestionSource | null = null,
  active = true,
  walkBoard?: QueueWalkBoard,
) {
  return render(
    createElement(QueueList, {
      presentation,
      queue,
      currentItem: queue.find(({ uuid }) => uuid === currentItemUuid) ?? null,
      board,
      isEditMode: false,
      showHistory: true,
      showFullHistory,
      selectedItems: new Set<string>(),
      playlistSuggestionSource,
      walkBoard,
      active,
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

  it('labels History, Now, Up next and Popular on this board in order', () => {
    feedFixture.climbs = [climb('s1')];
    const queue = ['h1', 'cur', 'f1'].map(item);
    const { container } = renderQueue(queue, 'cur');
    expect(headings(container)).toEqual([
      'queueList.sectionHistory',
      'queueList.sectionNow',
      'queueList.sectionUpNext',
      'queueList.sectionPopular',
    ]);
  });

  it('labels the current climb Now, on every platform, even alone', () => {
    const { container } = renderQueue([item('cur')], 'cur');
    expect(headings(container)).toEqual(['queueList.sectionNow']);
  });

  it('omits History when nothing has been climbed and the sections below the queue when they are empty', () => {
    const { container } = renderQueue([item('cur'), item('f1')], 'cur');
    expect(headings(container)).toEqual(['queueList.sectionNow', 'queueList.sectionUpNext']);
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

  it('puts one divider before the popular climbs and none before History, Now or Up next', () => {
    feedFixture.climbs = [climb('s1')];
    const { container, queryAllByTestId } = renderQueue(['h1', 'cur', 'f1'].map(item), 'cur');
    const dividers = queryAllByTestId('queue-off-queue-divider');
    expect(dividers).toHaveLength(1);
    const nextHeading = dividers[0].parentElement?.querySelector('h2');
    expect(nextHeading?.textContent).toBe('queueList.sectionPopular');
    expect(container.querySelectorAll('[data-testid="queue-off-queue-divider"]')).toHaveLength(1);
  });

  it('has no divider with nothing below the queue', () => {
    const { queryAllByTestId } = renderQueue(['h1', 'cur', 'f1'].map(item), 'cur');
    expect(queryAllByTestId('queue-off-queue-divider')).toHaveLength(0);
  });

  describe('Then from the list, and Popular on this board', () => {
    const list = ['l1', 'l2', 'l3', 'l4'].map(climb);
    const projects = (label?: string): PlaylistSuggestionSource => ({
      playlistUuid: 'projects',
      activatedClimbUuid: 'l1',
      boardKey: 'kilter:1:10:1,2',
      climbs: list,
      ...(label ? { label } : {}),
    });
    // The current climb is the list's second, so swipes play Up next (f1) and
    // then pick the list up at its third climb.
    const onList = (): ClimbQueueItem[] => [
      { uuid: 'cur', climb: list[1], suggested: true } as unknown as ClimbQueueItem,
      item('f1'),
    ];
    const offQueueRows = (container: HTMLElement) =>
      Array.from(container.querySelectorAll('button[aria-label]')).map((node) => node.getAttribute('aria-label'));

    it('lists what swipes reach after Up next under the name the top bar uses', () => {
      const { container } = renderQueue(onList(), 'cur', false, false, 'sheet', projects('Projects'));
      expect(headings(container)).toEqual([
        'queueList.sectionNow',
        'queueList.sectionUpNext',
        'queueList.sectionThenFrom(Projects)',
      ]);
      expect(offQueueRows(container)).toEqual(['Climb l3', 'Climb l4']);
    });

    it('splits the board feed off under its own header, leaving out the queue and Then from', () => {
      feedFixture.climbs = [climb('l3'), climb('c-f1'), climb('p1'), climb('p2'), climb('p1')];
      const { container, queryAllByTestId } = renderQueue(onList(), 'cur', false, false, 'sheet', projects('Projects'));
      expect(headings(container)).toEqual([
        'queueList.sectionNow',
        'queueList.sectionUpNext',
        'queueList.sectionThenFrom(Projects)',
        'queueList.sectionPopular',
      ]);
      expect(offQueueRows(container)).toEqual(['Climb l3', 'Climb l4', 'Climb p1', 'Climb p2']);
      // One divider: between the queue and everything below it.
      const dividers = queryAllByTestId('queue-off-queue-divider');
      expect(dividers).toHaveLength(1);
      expect(dividers[0].parentElement?.querySelector('h2')?.textContent).toBe('queueList.sectionThenFrom(Projects)');
    });

    it('says "the list" for a list nobody named', () => {
      const { container } = renderQueue(onList(), 'cur', false, false, 'sheet', projects());
      expect(headings(container)).toContain('queueList.sectionThenFromUnnamed');
    });

    it('says "the list" for a popular climb\'s track too, which the top bar names nothing', () => {
      // Not "Then from Popular on this board" over a "Popular on this board"
      // header: two near-identical headings, one of them a name the top bar
      // never shows.
      feedFixture.climbs = [climb('p1')];
      const feedTrack = { ...projects(), playlistUuid: 'queue-suggestions' };
      const { container } = renderQueue(onList(), 'cur', false, false, 'sheet', feedTrack);
      expect(headings(container)).toEqual([
        'queueList.sectionNow',
        'queueList.sectionUpNext',
        'queueList.sectionThenFromUnnamed',
        'queueList.sectionPopular',
      ]);
    });

    it("walks past a queued climb this wall can't draw, as the swipe does", () => {
      // The list holds a Tension climb, and a queued copy of it sits between the
      // current climb and the queued l3. On a Kilter board the swipe walks past
      // it onto that l3 (#6664), so Then from is only what lies beyond. A walk
      // blind to the board stops at it and lists a second l3 here.
      const tension = { uuid: 't1', name: 'Climb t1', boardType: 'tension', layoutId: 9 } as Climb;
      const mixedList = { ...projects('Projects'), climbs: [list[0], tension, list[1], list[2], list[3]] };
      const queue = [
        { uuid: 'cur', climb: list[1], suggested: true },
        { uuid: 'e-t1', climb: tension, suggested: true },
        { uuid: 'e-l3', climb: list[2], suggested: true },
      ] as unknown as ClimbQueueItem[];
      const kilter: QueueWalkBoard = { activeConfig: { boardName: 'kilter', layoutId: 1 } };
      const onKilter = renderQueue(queue, 'cur', false, false, 'sheet', mixedList, true, kilter);
      expect(offQueueRows(onKilter.container)).toEqual(['Climb l4']);
    });

    it('walks from the current climb the player walks from, even before the queue holds it', () => {
      // A commit the server hasn't echoed yet: the current climb is not in the
      // queue. The swipe walks the list on from it; so does Then from, rather
      // than the whole queue from the line.
      const pending = { uuid: 'pending', climb: list[1], suggested: true } as unknown as ClimbQueueItem;
      const { container } = render(
        createElement(QueueList, {
          presentation: 'sheet',
          queue: [item('f1')],
          currentItem: pending,
          board,
          isEditMode: false,
          showHistory: true,
          showFullHistory: false,
          selectedItems: new Set<string>(),
          playlistSuggestionSource: projects('Projects'),
          active: true,
          onToggleSelect: vi.fn(),
          onClimbPress: vi.fn(),
          onRemove: vi.fn(),
          onShowFullHistory: vi.fn(),
          onTickHistory: vi.fn(),
          onSuggestionPress: vi.fn(),
          reorderQueue: vi.fn(),
        }),
      );
      expect(offQueueRows(container)).toEqual(['Climb l3', 'Climb l4']);
    });

    it('walks nothing while the sheet is hidden', () => {
      const { container } = renderQueue(onList(), 'cur', false, false, 'sheet', projects('Projects'), false);
      expect(headings(container)).toEqual(['queueList.sectionNow', 'queueList.sectionUpNext']);
      expect(offQueueRows(container)).toEqual([]);
    });
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

    it('scrolls to the current climb counting the History and Now headers', () => {
      // rows: [History header, h1, divider, Now header, cur, Up next header, f1] -> cur is row 4.
      renderQueue(['h1', 'cur', 'f1'].map(item), 'cur', false, true);
      vi.advanceTimersByTime(400);
      expect(scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 4 }));
    });

    it('re-centres the side panel only when the current climb changes, not when rows arrive', () => {
      const props = (queue: ClimbQueueItem[], current: string) =>
        createElement(QueueList, {
          presentation: 'panel',
          queue,
          currentItem: queue.find(({ uuid }) => uuid === current) ?? null,
          board,
          isEditMode: false,
          showHistory: true,
          showFullHistory: false,
          selectedItems: new Set<string>(),
          playlistSuggestionSource: null,
          active: true,
          autoScrollOnMount: true,
          onToggleSelect: vi.fn(),
          onClimbPress: vi.fn(),
          onRemove: vi.fn(),
          onShowFullHistory: vi.fn(),
          onTickHistory: vi.fn(),
          onSuggestionPress: vi.fn(),
          reorderQueue: vi.fn(),
        });
      const { rerender } = render(props(['h1', 'cur', 'f1'].map(item), 'cur'));
      vi.advanceTimersByTime(400);
      expect(scrollToIndex).toHaveBeenCalledTimes(1);

      // A crew member queues another climb: the climber's scroll stays put.
      rerender(props(['h1', 'cur', 'f1', 'f2'].map(item), 'cur'));
      vi.advanceTimersByTime(400);
      expect(scrollToIndex).toHaveBeenCalledTimes(1);

      // Next climb: the panel follows it.
      rerender(props(['h1', 'cur', 'f1', 'f2'].map(item), 'f1'));
      vi.advanceTimersByTime(400);
      expect(scrollToIndex).toHaveBeenCalledTimes(2);
    });

    it('points the drag window at the first upcoming climb after the headers', () => {
      // rows: [History header, h1, divider, Now header, cur, Up next header, f1] -> f1 is row 6.
      renderQueue(['h1', 'cur', 'f1'].map(item), 'cur');
      expect(dragArgs.calls.at(-1)?.firstFutureRowIndex).toBe(6);
    });
  });
});
