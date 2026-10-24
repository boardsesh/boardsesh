// @vitest-environment jsdom
//
// The created-climbs sub-tab of the Profile tab. On iOS 26 the tab's segmented
// control floats over this list, and the list tells the header, through a store,
// when its rows are under the control.
import { act, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const feed = vi.hoisted(() => ({
  data: { pages: [{ climbs: [{ uuid: 'climb-1', name: 'Moonage' }] }] },
  isPending: false,
  isError: false,
  isFetchingNextPage: false,
  hasNextPage: false,
  fetchNextPage: vi.fn(),
}));
// Every prop the mounted list was given.
const list = vi.hoisted(() => ({ props: undefined as Record<string, unknown> | undefined }));
// What the screen handed the list-play hook, and the tap it got back.
type ListActivationOptions = {
  sourceId: string;
  label: string;
  rows: readonly { uuid: string }[];
  hasMore?: boolean;
  describeRow: (row: unknown) => { climb: unknown; board: unknown };
  loadMore?: () => Promise<{ rows: readonly { uuid: string }[]; hasMore: boolean }>;
};
const listActivation = vi.hoisted(() => ({
  open: vi.fn(),
  options: undefined as ListActivationOptions | undefined,
}));
const boardConfig = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
const rowProps = vi.hoisted(() => ({ current: [] as Record<string, unknown>[] }));

vi.mock('../../../hooks/use-native-root-header', () => ({ useNativeRootHeader: () => true }));
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: Record<string, unknown>) => {
    list.props = props;
    return createElement('div', { 'data-list': 'true' });
  },
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../Text', () => ({ Text: () => null }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-loading': 'true' }),
}));
vi.mock('../../ClimbListRow', () => ({
  ClimbListRow: (props: Record<string, unknown>) => {
    rowProps.current.push(props);
    return null;
  },
}));
// Scroll/layout tests stub rows and omit query/auth providers. Tick loading is
// exercised separately with the real provider in climb-progress-provider.test.tsx.
vi.mock('../../../providers/climb-progress-provider', () => ({
  ClimbProgressProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../../../lib/playlists/use-board-list-activation', () => ({
  useBoardListActivation: (options: ListActivationOptions) => {
    listActivation.options = options;
    return listActivation.open;
  },
}));
vi.mock('../../../lib/graphql/hooks', () => ({ useUserClimbs: () => feed }));
vi.mock('../../../lib/playlists/board-details-for-playlist', () => ({
  renderBoardToPlaylistConfig: () => boardConfig.current,
}));
vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ openPlayDrawer: vi.fn(), openClimbActions: vi.fn() }),
}));
vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8, 4: 16, 8: 32, 16: 64 } }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {} }) }));

import { ProfileClimbsTab } from '../ProfileClimbsTab';
import { createScrollEdgeBackdrop, type ScrollEdgeBackdrop } from '../../../hooks/use-scroll-edge-backdrop';

const SCROLL_LISTENERS = [
  'onScroll',
  'onScrollBeginDrag',
  'onScrollEndDrag',
  'onMomentumScrollBegin',
  'onMomentumScrollEnd',
] as const;

function scrollListTo(scrollEdge: ScrollEdgeBackdrop, offsetY: number) {
  scrollEdge.listProps.onScroll({ nativeEvent: { contentOffset: { x: 0, y: offsetY } } } as Parameters<
    ScrollEdgeBackdrop['listProps']['onScroll']
  >[0]);
}

describe('ProfileClimbsTab list under the floating profile header', () => {
  beforeEach(() => {
    feed.isPending = false;
    list.props = undefined;
  });

  it("gives its list every one of the store's scroll listeners", () => {
    const scrollEdge = createScrollEdgeBackdrop();
    render(<ProfileClimbsTab userId="user-1" scrollEdge={scrollEdge} />);

    for (const listener of SCROLL_LISTENERS) expect(list.props?.[listener]).toBe(scrollEdge.listProps[listener]);
  });

  // Under an opaque header the screen passes no store.
  it('gives its list no scroll listeners without a store', () => {
    render(<ProfileClimbsTab userId="user-1" />);

    expect(list.props).toBeDefined();
    for (const listener of SCROLL_LISTENERS) expect(list.props?.[listener]).toBeUndefined();
  });

  // The spinner replaces the list. What the list had scrolled under the header
  // must go with it, or the blur stays on over the spinner.
  it('puts the store at rest when its loading branch takes the list away', () => {
    const scrollEdge = createScrollEdgeBackdrop();
    const { container, rerender } = render(<ProfileClimbsTab userId="user-1" scrollEdge={scrollEdge} />);
    act(() => scrollListTo(scrollEdge, 400));
    expect(scrollEdge.isScrolledUnder()).toBe(true);

    feed.isPending = true;
    rerender(<ProfileClimbsTab userId="user-1" scrollEdge={scrollEdge} />);

    expect(container.querySelector('[data-list]')).toBeNull();
    expect(container.querySelector('[data-loading]')).not.toBeNull();
    expect(scrollEdge.isScrolledUnder()).toBe(false);
  });

  it('starts the list at rest again when it comes back', () => {
    const scrollEdge = createScrollEdgeBackdrop();
    feed.isPending = true;
    const { container, rerender } = render(<ProfileClimbsTab userId="user-1" scrollEdge={scrollEdge} />);
    // Something left the store scrolled while no list was mounted.
    act(() => scrollListTo(scrollEdge, 400));

    feed.isPending = false;
    rerender(<ProfileClimbsTab userId="user-1" scrollEdge={scrollEdge} />);

    expect(container.querySelector('[data-list]')).not.toBeNull();
    expect(scrollEdge.isScrolledUnder()).toBe(false);
  });
});

// Issue #6665: a profile's climbs play from that list, like every other list.
describe('ProfileClimbsTab row taps', () => {
  beforeEach(() => {
    feed.isPending = false;
    feed.hasNextPage = false;
    boardConfig.current = null;
    rowProps.current = [];
    listActivation.open.mockReset();
    listActivation.options = undefined;
  });

  it("plays from the profile's climbs, named for the player", () => {
    render(<ProfileClimbsTab userId="user-1" />);

    expect(listActivation.options).toMatchObject({
      sourceId: 'profile-climbs:user-1',
      label: 'playView.track.createdClimbs',
      hasMore: false,
    });
    expect(listActivation.options?.rows.map(({ uuid }) => uuid)).toEqual(['climb-1']);
  });

  it("hands each row the hook's tap", () => {
    boardConfig.current = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: [1, 2] };
    render(<ProfileClimbsTab userId="user-1" />);
    const renderItem = list.props?.renderItem as (info: { item: unknown }) => ReturnType<typeof createElement>;

    render(renderItem({ item: { uuid: 'climb-1', boardType: 'kilter', layoutId: 1, angle: 40 } }));

    expect(rowProps.current.at(-1)?.onPress).toBe(listActivation.open);
  });

  it('draws a climb on its own board at its own angle', () => {
    boardConfig.current = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: [1, 2] };
    render(<ProfileClimbsTab userId="user-1" />);
    const climb = { uuid: 'climb-2', boardType: 'kilter', layoutId: 1, angle: 35 };

    expect(listActivation.options?.describeRow(climb)).toEqual({
      climb,
      board: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 35 },
    });
  });

  it('pages on through the same feed', async () => {
    feed.hasNextPage = true;
    feed.fetchNextPage.mockResolvedValueOnce({
      isError: false,
      hasNextPage: false,
      data: { pages: [{ climbs: [{ uuid: 'climb-1' }] }, { climbs: [{ uuid: 'climb-2' }] }] },
    });
    render(<ProfileClimbsTab userId="user-1" />);

    const loaded = await listActivation.options?.loadMore?.();

    expect(feed.fetchNextPage).toHaveBeenCalledWith({ cancelRefetch: false });
    expect(loaded).toEqual({ rows: [{ uuid: 'climb-1' }, { uuid: 'climb-2' }], hasMore: false });
  });
});
