// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement, useRef, type ReactNode } from 'react';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { Climb } from '@boardsesh/shared-schema';

// Where each host of the climb row starts its separator. Every host here is the
// real module, drawing with the real spacing tokens, thumbnail width and inset
// helper: nothing below stands in for a number this file asserts. A host that
// hands the helper the wrong leading inset fails here.
//
// Each inset is checked twice: against the figure it has always been, and
// against the row the host actually draws (its padding, any slot in front, the
// thumbnail and its gaps), so a host cannot move its row and leave the line behind.
//
// The second half does the same with the climber's thumbnail switch off, where
// every host's line has to move back under its text.

vi.mock('react-native', async () => {
  const { flattenStyle } = await import('../../../test/flatten-style');
  const styled =
    (tag: string) =>
    ({ children, style }: { children?: ReactNode; style?: unknown }) =>
      createElement(tag, { 'data-style': JSON.stringify(flattenStyle(style)) }, children);
  return {
    useWindowDimensions: () => ({ fontScale: 1 }),
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
    useAnimatedReaction: () => undefined,
    interpolate: () => 0,
    Extrapolation: { CLAMP: 'clamp' },
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
    Gesture: {
      Pan: makeGesture,
      Tap: makeGesture,
      LongPress: makeGesture,
      Exclusive: makeGesture,
      Simultaneous: makeGesture,
    },
  };
});

vi.mock('react-native-gesture-handler/ReanimatedSwipeable', () => ({
  default: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

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

vi.mock('../../lib/haptics', () => ({
  hapticSelection: vi.fn(),
  hapticLight: vi.fn(),
  hapticMedium: vi.fn(),
  hapticSuccess: vi.fn(),
}));
vi.mock('../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../hooks/use-grade-format', () => ({ useGradeFormat: () => ({ formatGrade: () => 'V4' }) }));
vi.mock('../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children) }));
vi.mock('../Icon', () => ({ Icon: () => null }));
vi.mock('../PressableSurface', async () => {
  const { flattenStyle } = await import('../../../test/flatten-style');
  // The workout preview lays its row out on a PressableSurface, so its style is reported too.
  // The playlist editor's remove control takes its style as a function of the press state.
  const Surface = ({ children, style }: { children?: ReactNode; style?: unknown }) =>
    createElement(
      'div',
      { 'data-style': JSON.stringify(flattenStyle(typeof style === 'function' ? style({ pressed: false }) : style)) },
      children,
    );
  return { PressableSurface: Surface, StaticPressableSurface: Surface };
});
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
import { ClimbListRow } from '../ClimbListRow';
import { ClimbListRowSkeleton } from '../ClimbListRowSkeleton';
import { ClimbPreviewCard } from '../ClimbPreviewCard';
import { THUMBNAIL_WIDTH } from '../climb-list-thumbnail-metrics';
import { resetClimbRowDisplayForTests, setClimbRowField } from '../../lib/climb-row-display-preference';

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

type DrawnStyle = {
  height?: number;
  width?: number;
  marginStart?: number;
  marginLeft?: number;
  marginVertical?: number;
  paddingVertical?: number;
  flexDirection?: string;
  gap?: number;
  columnGap?: number;
  paddingHorizontal?: number;
  paddingStart?: number;
};

function drawnStyles(container: HTMLElement): DrawnStyle[] {
  return [...container.querySelectorAll('[data-style]')].map(
    (node) => JSON.parse(node.getAttribute('data-style') ?? '{}') as DrawnStyle,
  );
}

/** Where a host's row separators start: every hairline it draws with a start inset. */
function separatorInsets(container: HTMLElement): Array<number | undefined> {
  return drawnStyles(container)
    .filter((style) => style.height === HAIRLINE)
    .map((style) => style.marginStart ?? style.marginLeft)
    .filter((inset) => inset !== undefined);
}

/** The row a host lays the climb out in, read off what it drew: its leading padding and the gap between its columns. */
function drawnRow(container: HTMLElement): { leadingPadding: number; columnGap: number } {
  const row = drawnStyles(container).find(
    (style) =>
      style.flexDirection === 'row' &&
      (style.columnGap ?? style.gap) !== undefined &&
      (style.paddingHorizontal ?? style.paddingStart) !== undefined,
  );
  if (!row) throw new Error('The host drew no padded row with a column gap');
  return {
    leadingPadding: Number(row.paddingHorizontal ?? row.paddingStart),
    columnGap: Number(row.columnGap ?? row.gap),
  };
}

const listRowProps = { ...board, climb: climb as unknown as Climb };

beforeEach(() => {
  resetClimbRowDisplayForTests();
});

describe('where each climb row host starts its separator', () => {
  it('the Climbs list row: 104, under the text column', () => {
    const { container } = render(<ClimbListRow {...listRowProps} />);
    const row = drawnRow(container);

    expect(separatorInsets(container)).toEqual([104]);
    expect(row).toEqual({ leadingPadding: 16, columnGap: 12 });
    expect(row.leadingPadding + THUMBNAIL_WIDTH + row.columnGap).toBe(104);
  });

  // The row merges a caller's style over its own, last. A caller that sets the
  // inset means it; one that only tints the line keeps the row's inset.
  it('the Climbs list row keeps its inset under a caller’s separator style, unless that style sets one', () => {
    const tinted = render(<ClimbListRow {...listRowProps} separatorStyle={{ opacity: 0.5 }} />);
    expect(separatorInsets(tinted.container)).toEqual([104]);

    const fullWidth = render(<ClimbListRow {...listRowProps} separatorStyle={{ marginLeft: 0 }} />);
    expect(separatorInsets(fullWidth.container)).toEqual([0]);

    const none = render(<ClimbListRow {...listRowProps} showSeparator={false} />);
    expect(separatorInsets(none.container)).toEqual([]);
  });

  it('the loading placeholder: 104, the same as the row it stands in for', () => {
    const { container } = render(<ClimbListRowSkeleton />);
    const row = drawnRow(container);

    expect(separatorInsets(container)).toEqual([104]);
    expect(row.leadingPadding + THUMBNAIL_WIDTH + row.columnGap).toBe(104);
  });

  it('the queue row: 140, past its padding, the position slot and the thumbnail', () => {
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
    const row = drawnRow(container);

    expect(separatorInsets(container)).toEqual([140]);
    // The exported constant has to describe the row it comes from: the padding,
    // slot and gap that row actually draws are what push the thumbnail in.
    expect(drawnStyles(container).some((style) => style.width === POSITION_SLOT_WIDTH)).toBe(true);
    expect(row.leadingPadding + POSITION_SLOT_WIDTH + row.columnGap).toBe(QUEUE_ROW_LEADING_INSET);
    expect(QUEUE_ROW_LEADING_INSET + THUMBNAIL_WIDTH + row.columnGap).toBe(140);
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
    const row = drawnRow(container);

    // The list also draws a full-width divider, which has no start inset.
    expect(separatorInsets(container)).toEqual([140]);
    // Its spacer reserves the queue row's position slot, so the thumbnails line up as well.
    expect(drawnStyles(container).some((style) => style.width === POSITION_SLOT_WIDTH)).toBe(true);
    expect(row.leadingPadding + POSITION_SLOT_WIDTH + row.columnGap + THUMBNAIL_WIDTH + row.columnGap).toBe(140);
  });

  it('the playlist edit row: 148, past its padding, the remove control and the thumbnail', () => {
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
    const row = drawnRow(container);
    // The drag handle on the trailing edge is drawn in the same slot as the remove control in front.
    const controlSlot = drawnStyles(container).find((style) => style.height === 44 && style.width !== undefined);

    expect(separatorInsets(container)).toEqual([148]);
    expect(controlSlot?.width).toBe(36);
    expect(row.leadingPadding + Number(controlSlot?.width) + row.columnGap + THUMBNAIL_WIDTH + row.columnGap).toBe(148);
  });

  it('the workout preview row: 100, past its padding and the thumbnail', () => {
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
    const row = drawnRow(container);

    expect(separatorInsets(container)).toEqual([100]);
    expect(row.leadingPadding + THUMBNAIL_WIDTH + row.columnGap).toBe(100);
  });
});

// With thumbnails off the row visual draws no thumbnail and its text starts
// where the thumbnail did, so each host's line starts there too: at the host's
// own leading inset, with nothing added for a thumbnail that is not drawn.
describe('where each climb row host starts its separator with thumbnails switched off', () => {
  const playlistDrag = {
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

  const hosts = [
    {
      host: 'the Climbs list row',
      draw: () => render(<ClimbListRow {...listRowProps} />),
      withThumbnail: 104,
      withoutThumbnail: 16,
      leadingSlot: 0,
    },
    {
      host: 'the loading placeholder',
      draw: () => render(<ClimbListRowSkeleton />),
      withThumbnail: 104,
      withoutThumbnail: 16,
      leadingSlot: 0,
    },
    {
      host: 'the climb preview at the top of a sheet',
      draw: () => render(<ClimbPreviewCard climb={climb} {...board} />),
      withThumbnail: 104,
      withoutThumbnail: 16,
      leadingSlot: 0,
    },
    {
      host: 'the queue row',
      draw: () =>
        render(
          <QueueItemRow
            item={queueItem}
            position={1}
            board={board}
            isCurrentClimb={false}
            onPress={vi.fn()}
            onRemove={vi.fn()}
          />,
        ),
      withThumbnail: 140,
      withoutThumbnail: 52,
      leadingSlot: POSITION_SLOT_WIDTH,
    },
    {
      host: 'a queue suggestion row',
      draw: () =>
        render(
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
        ),
      withThumbnail: 140,
      withoutThumbnail: 52,
      leadingSlot: POSITION_SLOT_WIDTH,
    },
    {
      host: 'the playlist edit row',
      draw: () =>
        render(
          <PlaylistEditClimbRow
            climb={climb as unknown as Parameters<typeof PlaylistEditClimbRow>[0]['climb']}
            board={board}
            rowIndex={0}
            drag={playlistDrag}
            onRemove={vi.fn()}
            onReorder={vi.fn()}
          />,
        ),
      withThumbnail: 148,
      withoutThumbnail: 60,
      // Its remove control.
      leadingSlot: 36,
    },
    {
      host: 'the workout preview row',
      draw: () =>
        render(
          <WorkoutPreviewRow
            item={queueItem}
            board={board}
            isActive={false}
            isRefreshing={false}
            refreshDisabled={false}
            onPress={vi.fn()}
            onRefresh={vi.fn()}
          />,
        ),
      withThumbnail: 100,
      withoutThumbnail: 12,
      leadingSlot: 0,
    },
  ];

  it.each(hosts)('$host: $withoutThumbnail, where its text now starts', ({ draw, withoutThumbnail, leadingSlot }) => {
    setClimbRowField('thumbnail', false);

    const { container } = draw();
    const row = drawnRow(container);

    expect(separatorInsets(container)).toEqual([withoutThumbnail]);
    // The row's own padding, plus the slot in front of the climb and the gap after it.
    expect(row.leadingPadding + (leadingSlot > 0 ? leadingSlot + row.columnGap : 0)).toBe(withoutThumbnail);
  });

  it.each(hosts)(
    '$host moves its line when the switch is flipped under it',
    ({ draw, withThumbnail, withoutThumbnail }) => {
      const { container } = draw();
      expect(separatorInsets(container)).toEqual([withThumbnail]);

      act(() => setClimbRowField('thumbnail', false));
      expect(separatorInsets(container)).toEqual([withoutThumbnail]);

      act(() => setClimbRowField('thumbnail', true));
      expect(separatorInsets(container)).toEqual([withThumbnail]);
    },
  );

  it.each(hosts)('$host ignores every other switch', ({ draw, withThumbnail }) => {
    const { container } = draw();

    act(() => {
      for (const fieldId of ['communityGrade', 'sends', 'rating', 'setter', 'sentMark', 'quickActions'] as const) {
        setClimbRowField(fieldId, false);
      }
      setClimbRowField('playlistTags', true);
    });

    expect(separatorInsets(container)).toEqual([withThumbnail]);
  });
});

// A row without a thumbnail is as tall as its text, as little as 44pt. A 44pt
// control inside the row's 8pt padding would make it 60pt, so the control
// reaches into that padding instead. Beside a thumbnail nothing changes.
describe('a host’s 44pt controls in a row without a thumbnail', () => {
  /** Every 44pt-tall control the host drew, as its vertical margin (undefined for none). */
  function controlMargins(container: HTMLElement): Array<number | undefined> {
    return drawnStyles(container)
      .filter((style) => style.height === 44)
      .map((style) => style.marginVertical);
  }
  const rowPadding = (container: HTMLElement) =>
    drawnStyles(container).find((style) => style.flexDirection === 'row' && style.paddingVertical !== undefined)
      ?.paddingVertical;

  const drawHistoryQueueRow = () =>
    render(
      <QueueItemRow
        item={queueItem}
        position={1}
        board={board}
        isCurrentClimb={false}
        isHistoryItem
        onPress={vi.fn()}
        onRemove={vi.fn()}
        onTickHistory={vi.fn()}
      />,
    );
  const drawPlaylistEditRow = () =>
    render(
      <PlaylistEditClimbRow
        climb={climb as unknown as Parameters<typeof PlaylistEditClimbRow>[0]['climb']}
        board={board}
        rowIndex={0}
        drag={
          {
            shared: {
              activeUuid: { value: null },
              dragTranslateY: { value: 0 },
              activeRowIndex: { value: -1 },
              targetRowIndex: { value: -1 },
              rowHeight: { value: 0 },
            },
            onRowHeight: vi.fn(),
            makeHandleGesture: () => ({}),
          } as unknown as PlaylistDragControls
        }
        onRemove={vi.fn()}
        onReorder={vi.fn()}
      />,
    );

  it.each([
    { host: 'the queue row’s trailing button', draw: drawHistoryQueueRow, controls: 1 },
    { host: 'the playlist edit row’s remove control and drag handle', draw: drawPlaylistEditRow, controls: 2 },
  ])('$host: full height beside a thumbnail, inside the padding without one', ({ draw, controls }) => {
    const { container } = draw();
    expect(controlMargins(container)).toEqual(Array.from({ length: controls }, () => undefined));

    act(() => setClimbRowField('thumbnail', false));

    // Exactly the row's own vertical padding, taken back.
    expect(rowPadding(container)).toBe(8);
    expect(controlMargins(container)).toEqual(Array.from({ length: controls }, () => -8));
  });
});
