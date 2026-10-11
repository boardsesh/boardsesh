// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, useRef, type ReactNode } from 'react';
import type { ClimbQueueItem } from '@boardsesh/queue';

// Where each host of the climb row starts its separator. Every host here is the
// real module, drawing with the real spacing tokens, thumbnail width and inset
// helper: nothing below stands in for a number this file asserts. A host that
// hands the helper the wrong leading inset fails here.

vi.mock('react-native', async () => {
  const { flattenStyle } = await import('../../../test/flatten-style');
  const styled =
    (tag: string) =>
    ({ children, style }: { children?: ReactNode; style?: unknown }) =>
      createElement(tag, { 'data-style': JSON.stringify(flattenStyle(style)) }, children);
  return {
    Platform: { OS: 'ios', select: () => undefined },
    PlatformColor: (name: string) => name,
    DynamicColorIOS: (appearances: { light: string }) => appearances.light,
    StyleSheet: { create: <Styles,>(styles: Styles): Styles => styles, flatten: flattenStyle, hairlineWidth: 0.5 },
    View: styled('div'),
    Pressable: styled('button'),
    ActivityIndicator: () => null,
  };
});

vi.mock('react-native-reanimated', async () => {
  const { flattenStyle } = await import('../../../test/flatten-style');
  // The queue row lays itself out on an Animated.View, so its style is reported too.
  const AnimatedView = ({ children, style }: { children?: ReactNode; style?: unknown }) =>
    createElement('div', { 'data-style': JSON.stringify(flattenStyle(style)) }, children);
  return {
    default: { View: AnimatedView },
    useAnimatedStyle: (build: () => unknown) => build(),
    useSharedValue: (initial: unknown) => {
      const shared = useRef({ value: initial });
      return shared.current;
    },
    withSpring: (target: unknown) => target,
    withTiming: (target: unknown) => target,
    runOnJS:
      (run: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) =>
        run(...args),
  };
});

vi.mock('react-native-gesture-handler', () => {
  // Every method returns the same builder, so any chain a row configures resolves.
  const makeGesture = (): unknown => {
    const gesture: unknown = new Proxy({}, { get: () => () => gesture });
    return gesture;
  };
  return {
    GestureDetector: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    Gesture: { Pan: makeGesture, Tap: makeGesture, LongPress: makeGesture, Exclusive: makeGesture },
  };
});

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({
    systemColors: {
      background: '#fff',
      secondaryBackground: '#fff',
      separator: '#ccc',
      fill: '#eee',
      secondaryLabel: '#888',
      tertiaryLabel: '#aaa',
      error: '#f00',
    },
    brandColors: { primary: '#6D28D9', success: '#0a0', error: '#a00' },
    opacity: { disabled: 0.5 },
  }),
}));

vi.mock('../../lib/haptics', () => ({ hapticSelection: vi.fn(), hapticMedium: vi.fn() }));
vi.mock('../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../hooks/use-grade-format', () => ({ useGradeFormat: () => ({ formatGrade: () => 'V4' }) }));
vi.mock('../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children) }));
vi.mock('../Icon', () => ({ Icon: () => null }));
vi.mock('../PressableSurface', () => ({
  PressableSurface: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
// The row visual is not what is measured here, only where the line under it starts.
vi.mock('../ClimbListItemContent', () => ({ ClimbListItemContent: () => null }));
// Keeps the native image renderer out, and the real thumbnail size in.
vi.mock('../ClimbListThumbnail', async () => ({
  ...(await import('../climb-list-thumbnail-metrics')),
  ClimbListThumbnail: () => null,
}));
vi.mock('../board-presence/BoardDriverAvatar', () => ({ BoardDriverAvatar: () => null }));

// What the queue list needs around its rows: a list to draw them in, and a feed
// with one climb so it draws a suggestion row.
vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetFlatList: ({
    data,
    renderItem,
  }: {
    data: unknown[];
    renderItem: (info: { item: unknown; index: number }) => ReactNode;
  }) =>
    createElement(
      'div',
      null,
      data.map((item, index) => createElement('div', { key: index }, renderItem({ item, index }))),
    ),
}));
vi.mock('../sheet-content-inset', () => ({ withSheetBottomInset: (style: unknown) => style }));
vi.mock('../../hooks/use-window-bottom-inset', () => ({ useWindowBottomInset: () => 0 }));
vi.mock('../play-drawer/use-queue-drag', () => ({
  useQueueDrag: () => ({
    isDragging: false,
    controls: { shared: {}, onRowHeight: vi.fn(), makeHandleGesture: vi.fn() },
  }),
}));
vi.mock('../../providers/queue/use-board-continuation-feed', () => ({
  useBoardContinuationFeed: () => ({ climbs: [{ uuid: 'suggested', name: 'Suggested climb' }], isSettled: true }),
}));
vi.mock('../../providers/queue-provider', () => ({ useQueueSessionId: () => ({ sessionId: null }) }));
vi.mock('../../providers/party-profile-provider', () => ({
  usePartyProfile: () => ({ profile: null, isLoading: false }),
}));

import { QueueItemRow, POSITION_SLOT_WIDTH, QUEUE_ROW_LEADING_INSET, type QueueItemRowBoard } from '../QueueItemRow';
import { QueueList } from '../play-drawer/QueueList';
import { PlaylistEditClimbRow } from '../playlist/PlaylistEditClimbRow';
import type { PlaylistDragControls } from '../playlist/use-playlist-drag';
import { WorkoutPreviewRow } from '../session-screen/pre-session/WorkoutPreviewRow';
import { ClimbListRowSkeleton } from '../ClimbListRowSkeleton';
import { climbListRowStyles } from '../climb-list-row-styles';

const HAIRLINE = 0.5;

const board: QueueItemRowBoard = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 };
const climb = {
  uuid: 'c1',
  name: 'Boulder Problem',
  frames: 'p1r12',
  difficulty: '6b/V4',
  quality_average: '4.5',
  ascensionist_count: 12,
  setter_username: 'setterx',
};
const queueItem = { uuid: 'q1', climb, addedBy: null, source: null } as unknown as ClimbQueueItem;

type DrawnStyle = { height?: number; marginStart?: number; marginLeft?: number; [property: string]: unknown };

function drawnStyles(container: HTMLElement): DrawnStyle[] {
  return [...container.querySelectorAll('[data-style]')].map(
    (node) => JSON.parse(node.getAttribute('data-style') ?? '{}') as DrawnStyle,
  );
}

/** The one hairline a host draws under its row, and where it starts. */
function separatorInset(container: HTMLElement): number | undefined {
  const hairlines = drawnStyles(container).filter((style) => style.height === HAIRLINE);
  expect(hairlines).toHaveLength(1);
  return hairlines[0].marginStart ?? hairlines[0].marginLeft;
}

/** How far in a host's first column starts: its leading padding, straight off the drawn row. */
function leadingPadding(container: HTMLElement): unknown {
  const row = drawnStyles(container).find((style) => style.flexDirection === 'row' && 'columnGap' in style);
  return row?.paddingHorizontal ?? row?.paddingStart;
}

describe('where each climb row host starts its separator', () => {
  it('the Climbs list row and its loading placeholder: 104, under the text column', () => {
    expect(climbListRowStyles.separator.marginLeft).toBe(104);
    expect(climbListRowStyles.contentRow.paddingHorizontal).toBe(16);

    const { container } = render(<ClimbListRowSkeleton />);
    expect(separatorInset(container)).toBe(104);
  });

  it('the queue row: 140, past its 12pt padding, the position slot and the thumbnail', () => {
    expect(POSITION_SLOT_WIDTH).toBe(28);
    expect(QUEUE_ROW_LEADING_INSET).toBe(52);

    const { container } = render(
      <QueueItemRow
        item={queueItem}
        position={1}
        board={board}
        isCurrentClimb={false}
        onPress={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(separatorInset(container)).toBe(140);
    // The constant has to describe the row it is exported from: its padding, its
    // slot and one gap are what push the thumbnail in.
    const drawn = drawnStyles(container);
    const slot = drawn.find((style) => style.width === POSITION_SLOT_WIDTH);
    expect(slot).toBeDefined();
    expect(leadingPadding(container)).toBe(12);
    expect(12 + POSITION_SLOT_WIDTH + 12).toBe(QUEUE_ROW_LEADING_INSET);
  });

  it('a queue suggestion row: 140 too, lining up with the queue rows above it', () => {
    const { container } = render(
      <QueueList
        queue={[]}
        currentItemUuid={null}
        board={board}
        isEditMode={false}
        showHistory
        showFullHistory
        selectedItems={new Set<string>()}
        playlistSuggestionSource={null}
        active
        onToggleSelect={vi.fn()}
        onClimbPress={vi.fn()}
        onRemove={vi.fn()}
        onShowFullHistory={vi.fn()}
        onTickHistory={vi.fn()}
        onSuggestionPress={vi.fn()}
        reorderQueue={vi.fn()}
      />,
    );

    // The list also draws a full-width divider; a row separator is the hairline with a start inset.
    const rowSeparators = drawnStyles(container).filter(
      (style) => style.height === HAIRLINE && style.marginStart !== undefined,
    );
    expect(rowSeparators.map((style) => style.marginStart)).toEqual([140]);
    // Its spacer reserves the queue row's position slot, so the thumbnails line up as well.
    expect(drawnStyles(container).some((style) => style.width === POSITION_SLOT_WIDTH)).toBe(true);
  });

  it('the playlist edit row: 148, past its 12pt padding, the remove control and the thumbnail', () => {
    const drag = {
      shared: {
        activeUuid: { value: null },
        dragTranslateY: { value: 0 },
        activeRowIndex: { value: -1 },
        targetRowIndex: { value: -1 },
        rowHeight: { value: 0 },
      },
      onRowHeight: vi.fn(),
      makeHandleGesture: () => ({}),
    } as unknown as PlaylistDragControls;

    const { container } = render(
      <PlaylistEditClimbRow
        climb={climb as unknown as Parameters<typeof PlaylistEditClimbRow>[0]['climb']}
        board={board}
        rowIndex={0}
        drag={drag}
        onRemove={vi.fn()}
        onReorder={vi.fn()}
      />,
    );

    expect(separatorInset(container)).toBe(148);
    expect(leadingPadding(container)).toBe(12);
  });

  it('the workout preview row: 100, past its 12pt padding and the thumbnail', () => {
    const { container } = render(
      <WorkoutPreviewRow
        item={queueItem}
        board={board}
        isActive={false}
        isRefreshing={false}
        refreshDisabled={false}
        onPress={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    expect(separatorInset(container)).toBe(100);
  });
});
