// @vitest-environment jsdom
//
// The read-only climbs preview for a climber with no board. It is handed setups
// and reads no auth, so this suite mounts it with nothing but those props. The
// hero and the dock are the real components; only the board drawing is stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactElement, type ReactNode } from 'react';
import climbsCatalog from '@boardsesh/i18n/locales/en-US/climbs.json';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';
import type { NoBoardPreviewConfig } from '../../../lib/boards/no-board-preview';

type Children = { children?: ReactNode };
type PreviewClimb = { uuid: string; name: string; frames: string };
type SearchResult = {
  data: { pages: { climbs: PreviewClimb[] }[] } | undefined;
  isError: boolean;
  failureCount?: number;
};

const searchMock = vi.hoisted(() => vi.fn());
const refetchMock = vi.hoisted(() => vi.fn(async () => undefined));
const ensureBackgroundsMock = vi.hoisted(() => vi.fn(async () => null));
const rowContentProps = vi.hoisted(() => vi.fn());
const boardImageProps = vi.hoisted(() => vi.fn());
const renderDataMock = vi.hoisted(() => vi.fn());
const windowSize = vi.hoisted(() => ({ width: 393, height: 852 }));
const chromeMetrics = vi.hoisted(() => ({ scrollBottomPadding: 120, floatingControlBottom: 90 }));
// What the component subscribed with, by event name.
const keyboardListeners = vi.hoisted(() => new Map<string, () => void>());
// The setup's own list by board type, and a name search by the name asked for.
const searchResults = vi.hoisted(() => ({
  byBoard: {} as Record<string, SearchResult>,
  byName: {} as Record<string, SearchResult>,
}));

vi.mock('react-native', () => ({
  View: ({ children, testID }: Children & { testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  Pressable: ({
    children,
    onPress,
    testID,
    accessibilityHint,
    disabled,
  }: Children & { onPress?: () => void; testID?: string; accessibilityHint?: string; disabled?: boolean }) =>
    createElement(
      'button',
      { type: 'button', onClick: onPress, disabled, 'data-testid': testID, title: accessibilityHint },
      children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1, absoluteFill: {} },
  Platform: { OS: 'ios' },
  Keyboard: {
    isVisible: () => false,
    addListener: (eventName: string, listener: () => void) => {
      keyboardListeners.set(eventName, listener);
      return { remove: () => keyboardListeners.delete(eventName) };
    },
  },
  PixelRatio: { get: () => 3 },
  useWindowDimensions: () => windowSize,
  // Runs the task at once: the suite has no interactions to wait out.
  InteractionManager: {
    runAfterInteractions: (task: () => void) => {
      task();
      return { cancel: vi.fn() };
    },
  },
}));
vi.mock('@shopify/flash-list', () => ({
  FlashList: <TItem,>({
    data,
    renderItem,
    keyExtractor,
    contentContainerStyle,
    ListHeaderComponent,
    ListEmptyComponent,
    ListFooterComponent,
  }: {
    data: TItem[];
    renderItem: (info: { item: TItem; index: number }) => ReactElement;
    keyExtractor: (item: TItem) => string;
    contentContainerStyle?: { paddingBottom?: number };
    ListHeaderComponent?: ReactElement | null;
    ListEmptyComponent?: ReactElement | null;
    ListFooterComponent?: ReactElement | null;
  }) =>
    createElement(
      'div',
      { 'data-testid': 'list', 'data-padding-bottom': contentContainerStyle?.paddingBottom },
      ListHeaderComponent,
      data.length === 0
        ? ListEmptyComponent
        : data.map((item, index) => createElement('div', { key: keyExtractor(item) }, renderItem({ item, index }))),
      ListFooterComponent,
    ),
}));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: () => null }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 47, bottom: 0 }) }));
// Resolves against the real en-US catalog, with {{placeholder}} interpolation.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      const lookUp = (dottedKey: string) =>
        dottedKey
          .split('.')
          .reduce<unknown>(
            (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
            climbsCatalog,
          );
      // i18next's `context`: `key_<context>` when the catalog has it, else `key`.
      const contextual = values?.context === undefined ? undefined : lookUp(`${key}_${values.context}`);
      const found = typeof contextual === 'string' ? contextual : lookUp(key);
      if (typeof found !== 'string') return key;
      return found.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name] ?? ''));
    },
  }),
}));
vi.mock('../../Text', () => ({ Text: ({ children }: Children) => createElement('span', null, children) }));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, testID }: { title: string; onPress: () => void; testID?: string }) =>
    createElement('button', { type: 'button', onClick: onPress, 'data-testid': testID }, title),
}));
vi.mock('../../ClimbListItemContent', () => ({
  ClimbListItemContent: (props: { climb: PreviewClimb }) => {
    rowContentProps(props);
    return createElement('span', null, props.climb.name);
  },
  LiveClimbGrade: () => createElement('span', { 'data-testid': 'hero-grade' }),
  LiveClimbSubtitle: () => createElement('span', { 'data-testid': 'hero-stats' }),
}));
vi.mock('../../ClimbListThumbnail', () => ({ THUMBNAIL_WIDTH: 76 }));
vi.mock('../../ClimbListRowSkeleton', () => ({
  ClimbListRowSkeleton: () => createElement('div', { 'data-testid': 'skeleton-row' }),
}));
vi.mock('../../BoardImageNative', () => ({
  BoardImageNative: (props: { frames: string }) => {
    boardImageProps(props);
    return createElement('div', { 'data-testid': 'hero-board', 'data-frames': props.frames });
  },
}));
vi.mock('../../board-discovery/board-builder-labels', () => ({
  boardTypeLabel: (boardName: string) =>
    boardName === 'moonboard' ? 'MoonBoard' : boardName.charAt(0).toUpperCase() + boardName.slice(1),
}));
vi.mock('../../../lib/board-details', () => ({ getBoardRenderData: renderDataMock }));
vi.mock('../../../lib/spray/use-spray-wall-token', () => ({ useSprayWallToken: () => '' }));
vi.mock('../../climb-list-row-styles', () => ({ climbListRowStyles: { contentRow: {}, separator: {} } }));
vi.mock('../../board-discovery/BoardConfigChips', () => ({
  BoardConfigChips: ({
    groupLabel,
    options,
    onSelect,
  }: {
    groupLabel: string;
    options: { key: string; label: string; value: number; selected: boolean }[];
    onSelect: (value: number) => void;
  }) =>
    createElement(
      'div',
      { role: 'group', 'aria-label': groupLabel },
      options.map((option) =>
        createElement(
          'button',
          { key: option.key, type: 'button', 'aria-pressed': option.selected, onClick: () => onSelect(option.value) },
          option.label,
        ),
      ),
    ),
}));
vi.mock('../../../lib/graphql/hooks/use-infinite-search-climbs', () => ({
  useInfiniteSearchClimbs: (input: ClimbSearchInput, enabled: boolean, options: unknown) => {
    searchMock(input, enabled, options);
    const result = (input.name ? searchResults.byName[input.name] : searchResults.byBoard[input.boardName]) ?? {
      data: undefined,
      isError: false,
    };
    return { failureCount: 0, ...result, refetch: refetchMock };
  },
}));
vi.mock('../../../lib/background-image-cache', () => ({ ensureBackgroundsCached: ensureBackgroundsMock }));
vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => chromeMetrics,
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { background: '#000', separator: '#333', secondaryLabel: '#999', secondaryBackground: '#111' },
    brandColors: { primary: '#A78BFA' },
    variant: 'liquidGlass',
  }),
  useAppColorScheme: () => 'dark',
}));
vi.mock('../../../theme/colors', () => ({
  androidFallbackColors: { light: { background: '#F4F1FB' }, dark: { background: '#0F0B16' } },
}));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24 },
  borderRadius: { xl: 16, full: 9999 },
  shadows: { lg: {} },
}));

const { NoBoardClimbsPreview, NO_BOARD_PREVIEW_PAGE_SIZE } = await import('../NoBoardClimbsPreview');
const { publishConnectivityBannerHeight, __resetConnectivityBannerHeightForTests } =
  await import('../../../lib/connectivity-banner-inset-store');

const KILTER: NoBoardPreviewConfig = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 };
const TENSION: NoBoardPreviewConfig = { boardName: 'tension', layoutId: 9, sizeId: 1, setIds: '8,9', angle: 35 };

function climbsFor(names: string[]): SearchResult {
  return {
    data: { pages: [{ climbs: names.map((name) => ({ uuid: `uuid-${name}`, name, frames: `frames-${name}` })) }] },
    isError: false,
  };
}

const onFindBoard = vi.fn();
const onClimbPress = vi.fn();
const onHeroPress = vi.fn();
const onSearchSettled = vi.fn();

function preview(configs: readonly NoBoardPreviewConfig[], active?: boolean, searchName?: string) {
  return (
    <NoBoardClimbsPreview
      configs={configs}
      active={active}
      searchName={searchName}
      onFindBoard={onFindBoard}
      onClimbPress={onClimbPress}
      onHeroPress={onHeroPress}
      onSearchSettled={onSearchSettled}
    />
  );
}

function renderPreview(
  configs: readonly NoBoardPreviewConfig[] = [KILTER, TENSION],
  active?: boolean,
  searchName?: string,
) {
  return render(preview(configs, active, searchName));
}

function lastBoardImage() {
  return boardImageProps.mock.lastCall?.[0] as {
    frames: string;
    boardName: string;
    renderWidth: number;
    backgroundVariant: string;
    style: { width: number; height: number };
    playSurface?: boolean;
    retainPreviousOverlay?: boolean;
  };
}

describe('NoBoardClimbsPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    windowSize.width = 393;
    windowSize.height = 852;
    chromeMetrics.scrollBottomPadding = 120;
    chromeMetrics.floatingControlBottom = 90;
    keyboardListeners.clear();
    __resetConnectivityBannerHeightForTests();
    // A portrait wall, about the shape of a Kilter 12x12.
    renderDataMock.mockReturnValue({ boardWidth: 1080, boardHeight: 1500 });
    searchResults.byName = {};
    searchResults.byBoard = {
      kilter: climbsFor(['Jwb', 'Pinch Me']),
      tension: climbsFor(['Mirror Mirror']),
    };
  });
  afterEach(cleanup);

  it('searches the first setup by its config alone: one page of 30, most climbed first', () => {
    renderPreview();

    expect(NO_BOARD_PREVIEW_PAGE_SIZE).toBe(30);
    expect(searchMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1,20',
        angle: 40,
        page: 0,
        pageSize: 30,
        sortBy: 'ascents',
        sortOrder: 'desc',
      }),
      true,
      expect.anything(),
    );
  });

  it('lights the most sent climb on the big board and lists the rest under it', () => {
    renderPreview();

    const hero = screen.getByTestId('no-board-preview-hero');
    expect(hero.textContent).toContain('Jwb');
    expect(screen.getByTestId('hero-board').getAttribute('data-frames')).toBe('frames-Jwb');
    expect(screen.getByTestId('hero-grade')).toBeTruthy();
    expect(screen.getByTestId('hero-stats')).toBeTruthy();

    // The first climb is on the wall, so it is not also a row.
    expect(screen.queryByTestId('no-board-preview-row-0')).toBeNull();
    expect(screen.getByTestId('no-board-preview-row-1').textContent).toBe('Pinch Me');
    expect(rowContentProps).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        climb: expect.objectContaining({ name: 'Pinch Me' }),
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1,20',
        angle: 40,
        showAscentStatus: false,
      }),
    );
  });

  // 852 - 47 (status bar) - 90 (tab bar) - 50 (button) - 190 (chips, caption,
  // a peek of the next row) leaves more than the 380 cap.
  it('draws the board as tall as the first screen allows, overlay at display size, photo at full size', () => {
    renderPreview();

    const board = lastBoardImage();
    expect(board.style).toEqual({ width: 274, height: 380 });
    expect(board.renderWidth).toBe(274 * 3);
    expect(board.backgroundVariant).toBe('full');
    // Not the play view's board, and its holds fade in: holding the previous
    // overlay would switch that fade off.
    expect(board.playSurface).toBeUndefined();
    expect(board.retainPreviousOverlay).toBeUndefined();
  });

  it('still shows a board at least 200 points tall on an iPhone SE', () => {
    windowSize.width = 375;
    windowSize.height = 667;
    renderPreview();

    expect(lastBoardImage().style).toEqual({ width: 180, height: 250 });
  });

  it('says which board and angle the lit climb is from, with no title or paragraph above it', () => {
    renderPreview();

    expect(screen.getByText('Most sent on a Kilter board at 40°')).toBeTruthy();
    expect(screen.queryByText('Have a look around')).toBeNull();
  });

  // "A MoonBoard board" is not a thing anyone says.
  it('names a MoonBoard without calling it a board twice', () => {
    searchResults.byBoard = { moonboard: climbsFor(['Hard Times']) };
    renderPreview([{ boardName: 'moonboard', layoutId: 2, sizeId: 1, setIds: '3', angle: 40 }]);

    expect(screen.getByText('Most sent on a MoonBoard at 40°')).toBeTruthy();
  });

  it('keeps "Find my board" docked whatever the list shows', () => {
    renderPreview();

    fireEvent.click(screen.getByRole('button', { name: 'Find my board' }));
    expect(onFindBoard).toHaveBeenCalledOnce();
    expect(screen.getByTestId('no-board-preview-find-board')).toBeTruthy();
  });

  // The keys are translucent: a button left under them glows through.
  it('takes the dock away while the keyboard is up, and brings it back after', () => {
    renderPreview();

    act(() => keyboardListeners.get('keyboardWillShow')?.());
    expect(screen.queryByTestId('no-board-preview-find-board')).toBeNull();

    act(() => keyboardListeners.get('keyboardWillHide')?.());
    expect(screen.getByTestId('no-board-preview-find-board')).toBeTruthy();
  });

  // The banner floats above the bottom chrome and lifts everything anchored to
  // it. A dock lifted that far lands on the board's caption, and a board sized
  // against the lifted chrome shrinks under the climber.
  it('gives the connectivity banner the bottom of the screen: no dock, and the board keeps its size', () => {
    windowSize.width = 375;
    windowSize.height = 667;
    renderPreview();
    const sizeBefore = lastBoardImage().style;

    chromeMetrics.floatingControlBottom = 90 + 170;
    act(() => publishConnectivityBannerHeight(170));

    expect(screen.queryByTestId('no-board-preview-find-board')).toBeNull();
    expect(lastBoardImage().style).toEqual(sizeBefore);
  });

  // The tap opens the picker, not the climb, and the board says so up front.
  it('reports a tap on the lit board to its owner, and hints where it goes', () => {
    renderPreview();
    const hero = screen.getByTestId('no-board-preview-hero');

    expect(hero.getAttribute('title')).toBe('Opens the board picker. Pick your board to light this climb up.');
    fireEvent.click(hero);
    expect(onHeroPress).toHaveBeenCalledExactlyOnceWith(KILTER);
    expect(onClimbPress).not.toHaveBeenCalled();
  });

  // The row's index is the climb's place in the 30, not its place in the list.
  it("reports a row tap with the setup and the climb's place among the 30, and hints where it goes", () => {
    renderPreview();
    const firstRow = screen.getByTestId('no-board-preview-row-1');

    expect(firstRow.getAttribute('title')).toBe('Opens the board picker. Pick your board to open this climb.');
    fireEvent.click(firstRow);
    expect(onClimbPress).toHaveBeenCalledExactlyOnceWith(KILTER, 1);
  });

  it('offers a chip per board type and switches the board, the copy and the art', () => {
    renderPreview();
    expect(screen.getByRole('group', { name: 'Board type' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Kilter' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Tension' }));

    expect(screen.getByTestId('hero-board').getAttribute('data-frames')).toBe('frames-Mirror Mirror');
    expect(lastBoardImage().boardName).toBe('tension');
    expect(screen.queryByText('Jwb')).toBeNull();
    expect(screen.getByText('Most sent on a Tension board at 35°')).toBeTruthy();
    expect(searchMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ boardName: 'tension', angle: 35 }),
      true,
      expect.anything(),
    );
    expect(ensureBackgroundsMock).toHaveBeenLastCalledWith({
      boardName: 'tension',
      layoutId: 9,
      sizeId: 1,
      setIds: [8, 9],
      colorScheme: 'dark',
    });

    fireEvent.click(screen.getByTestId('no-board-preview-hero'));
    expect(onHeroPress).toHaveBeenCalledExactlyOnceWith(TENSION);
  });

  it('starts the next board type at the top of a fresh list', () => {
    // FlashList keeps its scroll offset when only its data changes, so a
    // climber at the end of one board's climbs would land at the end of the
    // next. A list per setup is a new node, and a new node starts at the top.
    renderPreview();
    const kilterList = screen.getByTestId('list');

    fireEvent.click(screen.getByRole('button', { name: 'Tension' }));

    expect(screen.getByTestId('list')).not.toBe(kilterList);
  });

  it('shows no chips when there is only one board type to offer, and gives the board their room', () => {
    windowSize.width = 375;
    windowSize.height = 667;
    renderPreview([KILTER]);

    expect(screen.queryByRole('group')).toBeNull();
    // 44 points more than with chips: 667 - 47 - 90 - 50 - 186.
    expect(lastBoardImage().style.height).toBe(294);
  });

  it('warms the board art for the setup it shows', () => {
    renderPreview();

    expect(ensureBackgroundsMock).toHaveBeenCalledExactlyOnceWith({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: [1, 20],
      colorScheme: 'dark',
    });
  });

  it('shows the unlit wall, skeleton rows and the dock while the search is loading', () => {
    searchResults.byBoard = {};
    renderPreview();

    expect(screen.getByTestId('hero-board').getAttribute('data-frames')).toBe('');
    expect(screen.getByTestId('no-board-preview-hero-loading')).toBeTruthy();
    expect(screen.getAllByTestId('skeleton-row')).toHaveLength(4);
    expect(screen.getByRole('button', { name: 'Find my board' })).toBeTruthy();
    // An unlit wall is not a climb to open.
    expect((screen.getByTestId('no-board-preview-hero') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/top \d+/)).toBeNull();
    expect(onSearchSettled).not.toHaveBeenCalled();
  });

  it.each([
    ['ready', climbsFor(['Jwb'])],
    ['empty', climbsFor([])],
    ['error', { data: undefined, isError: true }],
  ] as const)('tells its owner when the search ends in %s', (outcome, result) => {
    searchResults.byBoard = { kilter: result };
    renderPreview();

    expect(onSearchSettled).toHaveBeenCalledExactlyOnceWith(outcome, KILTER);
  });

  // React Query retries twice more before `isError`. That is seconds of
  // skeleton on a backend that is not answering.
  it('calls the first failed attempt an error, without waiting out the retries', () => {
    searchResults.byBoard = { kilter: { data: undefined, isError: false, failureCount: 1 } };
    renderPreview();

    expect(onSearchSettled).toHaveBeenCalledExactlyOnceWith('error', KILTER);
  });

  // Before any climbs have shown, the owner takes the preview away on a
  // failure, so nothing but the loading state is drawn in between.
  it('keeps the loading state when the first setup fails', () => {
    searchResults.byBoard = { kilter: { data: undefined, isError: true } };
    renderPreview();

    expect(screen.getAllByTestId('skeleton-row')).toHaveLength(4);
    expect(screen.queryByTestId('no-board-preview-problem')).toBeNull();
  });

  it('shows a later board type that fails in place: unlit wall, a way to try again, chips and dock still up', () => {
    searchResults.byBoard = { kilter: climbsFor(['Jwb']), tension: { data: undefined, isError: true } };
    renderPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Tension' }));

    expect(screen.getByTestId('no-board-preview-problem').textContent).toContain("Couldn't load these climbs.");
    expect(screen.getByTestId('hero-board').getAttribute('data-frames')).toBe('');
    // Nothing came back, so nothing is claimed about what is most sent.
    expect(screen.queryByText(/Most sent/)).toBeNull();
    expect(screen.queryByTestId('skeleton-row')).toBeNull();
    expect(screen.getByRole('button', { name: 'Find my board' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetchMock).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Kilter' }));
    expect(screen.getByText('Jwb')).toBeTruthy();
  });

  it('says so in place when a later board type has no climbs', () => {
    searchResults.byBoard = { kilter: climbsFor(['Jwb']), tension: climbsFor([]) };
    renderPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Tension' }));

    expect(screen.getByText('No climbs found')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Find my board' })).toBeTruthy();
  });

  // Covered by another screen: no search, no board art, no board photo decode,
  // until it is seen.
  it('searches nothing, fetches no board art and mounts no board while it is not active', () => {
    searchResults.byBoard = {};
    const { rerender } = renderPreview([KILTER], false);

    expect(searchMock).toHaveBeenLastCalledWith(expect.anything(), false, expect.anything());
    expect(ensureBackgroundsMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('hero-board')).toBeNull();

    rerender(preview([KILTER], true));
    expect(searchMock).toHaveBeenLastCalledWith(expect.anything(), true, expect.anything());
    expect(ensureBackgroundsMock).toHaveBeenCalledOnce();
    expect(screen.getByTestId('hero-board')).toBeTruthy();

    // Seen once, the board stays mounted under whatever covers the screen next.
    rerender(preview([KILTER], false));
    expect(screen.getByTestId('hero-board')).toBeTruthy();
  });

  it('ends the list by saying how many that was and pointing back at the picker', () => {
    renderPreview();

    expect(screen.getByText("That's the top 2. Find your board to see every climb on it.")).toBeTruthy();
  });

  // Scroll padding (120) + the button (50) + its gap (8) + room above it (24).
  it('pads the list so the last row and the footer scroll clear of the dock', () => {
    renderPreview();

    expect(screen.getByTestId('list').getAttribute('data-padding-bottom')).toBe('202');
  });

  it('is the plain list from the first climb when the board cannot be sized', () => {
    renderDataMock.mockReturnValue(null);
    renderPreview();

    expect(screen.queryByTestId('no-board-preview-hero')).toBeNull();
    expect(screen.getByTestId('no-board-preview-row-0').textContent).toBe('Jwb');
    fireEvent.click(screen.getByTestId('no-board-preview-row-1'));
    expect(onClimbPress).toHaveBeenCalledExactlyOnceWith(KILTER, 1);
  });

  describe('a name typed in the Climbs search field', () => {
    it("lists the setup's climbs with that name in place of the lit board, still one page", () => {
      searchResults.byName = { pin: climbsFor(['Pinch Me']) };
      renderPreview(undefined, true, ' pin ');

      expect(searchMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ boardName: 'kilter', name: 'pin', page: 0, pageSize: 30 }),
        true,
        expect.anything(),
      );
      expect(screen.getByText('Climbs matching "pin"')).toBeTruthy();
      expect(screen.queryByTestId('no-board-preview-hero')).toBeNull();
      expect(screen.getByTestId('no-board-preview-row-0').textContent).toBe('Pinch Me');
      // "The top 30" is not what a name search shows.
      expect(screen.queryByText(/top \d+/)).toBeNull();
      expect(screen.getByRole('button', { name: 'Find my board' })).toBeTruthy();
      expect(screen.getByRole('group', { name: 'Board type' })).toBeTruthy();
    });

    // A name nobody used is not a setup with no climbs: the owner would take
    // the whole preview away for it.
    it('says so in place when no climb has that name, and never tells its owner', () => {
      searchResults.byName = { zzzz: climbsFor([]) };
      renderPreview(undefined, true, 'zzzz');

      expect(screen.getByText('No climb called "zzzz" on this board.')).toBeTruthy();
      expect(screen.queryByTestId('no-board-preview-problem')).toBeNull();
      expect(screen.queryByTestId('skeleton-row')).toBeNull();
      expect(onSearchSettled).toHaveBeenCalledExactlyOnceWith('ready', KILTER);
    });

    it('shows skeleton rows while the name is being looked up', () => {
      renderPreview(undefined, true, 'pin');

      expect(screen.getByText('Climbs matching "pin"')).toBeTruthy();
      expect(screen.getAllByTestId('skeleton-row')).toHaveLength(4);
    });

    it('offers to try again when the name search fails', () => {
      searchResults.byName = { pin: { data: undefined, isError: true } };
      renderPreview(undefined, true, 'pin');

      expect(screen.getByTestId('no-board-preview-problem').textContent).toContain("Couldn't load these climbs.");
      expect(onSearchSettled).toHaveBeenCalledExactlyOnceWith('ready', KILTER);
    });

    it('brings the lit board back when the field is cleared', () => {
      searchResults.byName = { pin: climbsFor(['Pinch Me']) };
      const { rerender } = renderPreview(undefined, true, 'pin');
      expect(screen.queryByTestId('no-board-preview-hero')).toBeNull();

      rerender(preview([KILTER, TENSION], true, ''));

      expect(screen.getByTestId('hero-board').getAttribute('data-frames')).toBe('frames-Jwb');
    });

    it('does not search a single letter', () => {
      renderPreview(undefined, true, 'p');

      expect(screen.getByTestId('no-board-preview-hero')).toBeTruthy();
      expect(searchMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: expect.anything() }),
        expect.anything(),
        expect.anything(),
      );
    });

    // Until climbs have shown, the screen can still go back to the placard,
    // and a name with no match must not be what sends it there.
    it('is ignored until the preview has shown climbs', () => {
      searchResults.byBoard = { kilter: climbsFor([]) };
      renderPreview(undefined, true, 'pin');

      expect(searchMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: expect.anything() }),
        expect.anything(),
        expect.anything(),
      );
      expect(onSearchSettled).toHaveBeenCalledExactlyOnceWith('empty', KILTER);
    });
  });
});
