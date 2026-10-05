// @vitest-environment jsdom
//
// The read-only climbs list for a climber with no board. It is handed setups
// and reads no auth, so this suite mounts it with nothing but those props.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactElement, type ReactNode } from 'react';
import climbsCatalog from '@boardsesh/i18n/locales/en-US/climbs.json';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';
import type { NoBoardPreviewConfig } from '../../../lib/boards/no-board-preview';

type Children = { children?: ReactNode };
type PreviewClimb = { uuid: string; name: string };
type SearchResult = { data: { pages: { climbs: PreviewClimb[] }[] } | undefined; isError: boolean };

const searchMock = vi.hoisted(() => vi.fn());
const ensureBackgroundsMock = vi.hoisted(() => vi.fn(async () => null));
const rowContentProps = vi.hoisted(() => vi.fn());
const searchResults = vi.hoisted(() => ({ byBoard: {} as Record<string, SearchResult> }));

vi.mock('react-native', () => ({
  View: ({ children, testID }: Children & { testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  Pressable: ({
    children,
    onPress,
    testID,
    accessibilityHint,
  }: Children & { onPress?: () => void; testID?: string; accessibilityHint?: string }) =>
    createElement(
      'button',
      { type: 'button', onClick: onPress, 'data-testid': testID, title: accessibilityHint },
      children,
    ),
  ActivityIndicator: () => createElement('div', { 'data-testid': 'spinner' }),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
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
    ListFooterComponent,
  }: {
    data: TItem[];
    renderItem: (info: { item: TItem; index: number }) => ReactElement;
    keyExtractor: (item: TItem) => string;
    ListFooterComponent?: ReactElement;
  }) =>
    createElement(
      'div',
      { 'data-testid': 'list' },
      data.map((item, index) => createElement('div', { key: keyExtractor(item) }, renderItem({ item, index }))),
      ListFooterComponent,
    ),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 47, bottom: 0 }) }));
// Resolves against the real en-US catalog, with {{placeholder}} interpolation.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      const found = key
        .split('.')
        .reduce<unknown>(
          (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
          climbsCatalog,
        );
      if (typeof found !== 'string') return key;
      return found.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name] ?? ''));
    },
  }),
}));
vi.mock('../../Text', () => ({ Text: ({ children }: Children) => createElement('span', null, children) }));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { type: 'button', onClick: onPress }, title),
}));
vi.mock('../../ClimbListItemContent', () => ({
  ClimbListItemContent: (props: { climb: PreviewClimb }) => {
    rowContentProps(props);
    return createElement('span', null, props.climb.name);
  },
}));
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
    return searchResults.byBoard[input.boardName] ?? { data: undefined, isError: false };
  },
}));
vi.mock('../../../lib/background-image-cache', () => ({ ensureBackgroundsCached: ensureBackgroundsMock }));
vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 120 }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { background: '#fff', separator: '#ddd', secondaryLabel: '#666' } }),
  useAppColorScheme: () => 'dark',
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20 } }));

const { NoBoardClimbsPreview, NO_BOARD_PREVIEW_PAGE_SIZE } = await import('../NoBoardClimbsPreview');

const KILTER: NoBoardPreviewConfig = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 };
const TENSION: NoBoardPreviewConfig = { boardName: 'tension', layoutId: 9, sizeId: 1, setIds: '8,9', angle: 35 };

function climbsFor(names: string[]): SearchResult {
  return {
    data: { pages: [{ climbs: names.map((name) => ({ uuid: `uuid-${name}`, name })) }] },
    isError: false,
  };
}

const onFindBoard = vi.fn();
const onClimbPress = vi.fn();
const onSearchSettled = vi.fn();

function renderPreview(configs: readonly NoBoardPreviewConfig[] = [KILTER, TENSION]) {
  return render(
    <NoBoardClimbsPreview
      configs={configs}
      onFindBoard={onFindBoard}
      onClimbPress={onClimbPress}
      onSearchSettled={onSearchSettled}
    />,
  );
}

describe('NoBoardClimbsPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("lists the setup's climbs as rows drawn for that setup, with no status of the climber's own", () => {
    renderPreview();

    expect(screen.getByText('Jwb')).toBeTruthy();
    expect(screen.getByText('Pinch Me')).toBeTruthy();
    expect(rowContentProps).toHaveBeenCalledWith(
      expect.objectContaining({
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1,20',
        angle: 40,
        showAscentStatus: false,
      }),
    );
  });

  it('says which board and angle the climbs are from, and keeps "Find my board" above them', () => {
    renderPreview();

    expect(screen.getByText('Have a look around')).toBeTruthy();
    expect(
      screen.getByText('Popular climbs on a Kilter board at 40°. Pick your board to open them and light them up.'),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Find my board' }));
    expect(onFindBoard).toHaveBeenCalledOnce();
  });

  // The tap opens the picker, not the climb, and the row says so up front.
  it('reports a row tap with the setup and the row index, and hints where it goes', () => {
    renderPreview();
    const secondRow = screen.getByTestId('no-board-preview-row-1');

    expect(secondRow.getAttribute('title')).toBe('Opens the board picker. Pick your board to open this climb.');
    fireEvent.click(secondRow);
    expect(onClimbPress).toHaveBeenCalledExactlyOnceWith(KILTER, 1);
  });

  it('offers a chip per board type and switches the list, the copy and the art', () => {
    renderPreview();
    expect(screen.getByRole('group', { name: 'Board type' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Kilter' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Tension' }));

    expect(screen.getByText('Mirror Mirror')).toBeTruthy();
    expect(screen.queryByText('Jwb')).toBeNull();
    expect(
      screen.getByText('Popular climbs on a Tension board at 35°. Pick your board to open them and light them up.'),
    ).toBeTruthy();
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

    fireEvent.click(screen.getByText('Mirror Mirror'));
    expect(onClimbPress).toHaveBeenCalledExactlyOnceWith(TENSION, 0);
  });

  it('shows no chips when there is only one board type to offer', () => {
    renderPreview([KILTER]);

    expect(screen.queryByRole('group')).toBeNull();
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

  it('shows a spinner and reports nothing while the search is loading', () => {
    searchResults.byBoard = {};
    renderPreview();

    expect(screen.getByTestId('spinner')).toBeTruthy();
    expect(screen.queryByTestId('list')).toBeNull();
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

  it('ends the list by pointing back at the picker', () => {
    renderPreview();

    expect(screen.getByText('Pick your board to see the rest.')).toBeTruthy();
  });
});
