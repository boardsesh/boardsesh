// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SettingsChange } from '../../../../src/settings/hooks';

// Home's sections, mounted by the real layout: each card is a recorder, so a
// card that never mounts never ran its hooks, and never asked for anything.
const recorded = vi.hoisted(() => ({
  crewFeedEnabled: [] as boolean[],
  sessionFeedEnabled: [] as boolean[],
  railProps: [] as Array<{ enabled: boolean; showStartPrompt?: boolean }>,
  betaProps: [] as Array<{ boardType: string | null; layoutId: number | null; enabled: boolean }>,
  chrome: [] as Array<{ showScopeMenu: boolean; scopeTitle: string; scopeActions: unknown[] }>,
  customizeSheet: [] as boolean[],
  selectScopeIndex: null as ((index: number) => void) | null,
}));
const focus = vi.hoisted(() => ({ hasBeenFocused: true }));
const homeBoardState = vi.hoisted(() => ({
  board: null as { uuid: string; boardType: string; layoutId: number; name: string; gymName: string | null } | null,
  isResolving: false,
  boards: [] as unknown[],
}));
const refresh = vi.hoisted(() => ({
  onRefresh: null as (() => void) | null,
  refreshing: false,
  invalidateQueries: vi.fn((_filters: unknown): Promise<void> => Promise.resolve()),
}));
const settings = vi.hoisted(() => ({
  listeners: new Set<(change: SettingsChange) => void>(),
  values: new Map<string, unknown>(),
}));

vi.mock('../../../../src/settings/hooks', () => ({
  subscribeSettings: (listener: (change: SettingsChange) => void) => {
    settings.listeners.add(listener);
    return () => settings.listeners.delete(listener);
  },
  getSetting: (key: string) => settings.values.get(key) ?? null,
  setSetting: (key: string, value: unknown) => {
    settings.values.set(key, value);
    for (const listener of settings.listeners) listener({ kind: 'setting', key: key as never });
  },
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (name: string) => name,
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  RefreshControl: ({ onRefresh, refreshing }: { onRefresh: () => void; refreshing: boolean }) => {
    refresh.onRefresh = onRefresh;
    refresh.refreshing = refreshing;
    return null;
  },
}));
vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    data,
    ListHeaderComponent,
    ListEmptyComponent,
    refreshControl,
  }: {
    data: unknown[];
    ListHeaderComponent?: ReactNode;
    ListEmptyComponent?: ReactNode;
    refreshControl?: ReactNode;
  }) => createElement('div', null, refreshControl, ListHeaderComponent, data.length === 0 ? ListEmptyComponent : null),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: refresh.invalidateQueries }),
}));
vi.mock('../../../../src/lib/routing/scoped-navigation', () => ({
  useScopedRouter: () => ({ push: vi.fn(), navigate: vi.fn() }),
}));
vi.mock('../../../../src/hooks/use-native-root-header', () => ({ useNativeRootHeader: () => false }));
vi.mock('../../../../src/hooks/use-has-been-focused', () => ({ useHasBeenFocused: () => focus.hasBeenFocused }));
vi.mock('../../../../src/hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../../src/hooks/use-offline-query-state', () => ({
  useOfflineQueryState: () => ({ isBlocked: false, reason: null }),
}));
vi.mock('../../../../src/components/ReadableColumn', () => ({
  ReadableColumn: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../../../src/components/Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('p', null, children),
}));
vi.mock('../../../../src/components/Icon', () => ({ Icon: () => null }));
vi.mock('../../../../src/components/Card', () => ({
  Card: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../../../src/components/Button', () => ({
  Button: ({ title, onPress, testID }: { title: string; onPress: () => void; testID?: string }) =>
    createElement('button', { onClick: onPress, 'data-testid': testID }, title),
}));
vi.mock('../../../../src/components/AppStorePrompt', () => ({ AppStorePrompt: () => null }));
vi.mock('../../../../src/components/you/SessionFeedCard', () => ({ SessionFeedCard: () => null }));
vi.mock('../../../../src/components/feed/NewClimbFeedCard', () => ({ NewClimbFeedCard: () => null }));
vi.mock('../../../../src/components/you/CommentSheet', () => ({ CommentSheet: () => null }));
vi.mock('../../../../src/components/feed/FeedScopeTitle', () => ({ FeedScopeTitle: () => null }));
vi.mock('../../../../src/components/feed/HomeTopChrome', () => ({
  TOP_ISLAND_BAND: 56,
  HomeTopChrome: (props: {
    showScopeMenu: boolean;
    scopeTitle: string;
    scopeActions: unknown[];
    onSelectScopeIndex: (index: number) => void;
  }) => {
    recorded.selectScopeIndex = props.onSelectScopeIndex;
    recorded.chrome.push({
      showScopeMenu: props.showScopeMenu,
      scopeTitle: props.scopeTitle,
      scopeActions: props.scopeActions,
    });
    return null;
  },
}));
vi.mock('../../../../src/components/OfflineState', () => ({ OfflineState: () => null }));
vi.mock('../../../../src/components/session-screen/InviteSheet', () => ({ InviteSheet: () => null }));
vi.mock('../../../../src/components/ScreenshotSmokeMarker', () => ({ ScreenshotSmokeMarker: () => null }));
vi.mock('../../../../src/components/home/HomeCustomizeSheet', () => ({
  HomeCustomizeSheet: ({ visible }: { visible: boolean }) => {
    recorded.customizeSheet.push(visible);
    return null;
  },
}));
vi.mock('../../../../src/components/home/HomeBoardSection', () => ({
  HomeBoardSection: () => createElement('div', { 'data-testid': 'section-board' }),
}));
vi.mock('../../../../src/components/home/HomeSessionSection', () => ({
  HomeSessionSection: () => createElement('div', { 'data-testid': 'section-session' }),
}));
vi.mock('../../../../src/components/home/HomePlaylistsSection', () => ({
  HomePlaylistsSection: () => createElement('div', { 'data-testid': 'section-playlists' }),
}));
vi.mock('../../../../src/components/home/HomeBetaSection', () => ({
  HomeBetaSection: (props: { boardType: string | null; layoutId: number | null; enabled: boolean }) => {
    recorded.betaProps.push(props);
    return createElement('div', { 'data-testid': 'section-beta' });
  },
}));
vi.mock('../../../../src/components/live-sessions/LiveSessionsRail', () => ({
  LiveSessionsRail: (props: { enabled: boolean; showStartPrompt?: boolean }) => {
    recorded.railProps.push(props);
    return createElement('div', { 'data-testid': 'section-climbingNow' });
  },
}));

function feedQuery() {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    isRefetching: false,
    isFetchingNextPage: false,
    hasNextPage: false,
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
  };
}
vi.mock('../../../../src/lib/graphql/hooks/use-crew-feed', () => ({
  useCrewFeed: (enabled: boolean) => {
    recorded.crewFeedEnabled.push(enabled);
    return feedQuery();
  },
}));
vi.mock('../../../../src/lib/graphql/hooks', () => ({
  useSessionGroupedFeed: (_input: unknown, enabled: boolean) => {
    recorded.sessionFeedEnabled.push(enabled);
    return feedQuery();
  },
  useBulkVoteSummaries: () => ({ data: undefined, refetch: vi.fn() }),
}));
vi.mock('../../../../src/lib/graphql/query-keys', () => ({
  FOLLOWED_LIVE_SESSIONS_QUERY_KEY: ['followed'],
  SESSION_SUMMARY_QUERY_KEY: 'sessionSummary',
  RECENT_BETA_LINKS_QUERY_KEY: 'recentBetaLinks',
}));
vi.mock('@boardsesh/playlists-react', () => ({ SMART_PLAYLIST_COUNTS_QUERY_KEY: 'mySmartPlaylistCounts' }));
vi.mock('../../../../src/lib/graphql/hooks/use-home-board', () => ({
  useHomeBoard: () => homeBoardState,
}));
vi.mock('../../../../src/providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../../../../src/providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, brandColors: { primary: 'brand' } }),
}));
vi.mock('../../../../src/providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ openPlayDrawer: vi.fn() }),
}));
vi.mock('../../../../src/lib/feed-time-buckets', () => ({ dedupeSessionsById: (sessions: unknown[]) => sessions }));
vi.mock('../../../../src/lib/feed/crew-page-state', () => ({
  createFeedPageGate: () => ({ claim: () => true, release: () => {} }),
  requiresCrewPageTap: () => false,
}));
vi.mock('../../../../src/lib/feed/vote-summary-map', () => ({
  buildVoteSummaryMap: () => new Map(),
  voteSummaryKey: () => '',
}));
// The list-play hook has its own suite; here the cards only have to reach it.
vi.mock('../../../../src/lib/playlists/use-tick-list-activation', () => ({ useTickListActivation: () => vi.fn() }));
vi.mock('../../../../src/lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../../../src/lib/session-feed-navigation', () => ({ navigateToSessionFeedItem: vi.fn() }));
vi.mock('../../../../src/lib/profiling/HomeStartupCommit', () => ({ HomeStartupCommit: () => null }));
vi.mock('../../../../src/lib/profiling/startup-profile', () => ({ STARTUP_PROFILING_ENABLED: false }));
vi.mock('../../../../src/lib/profiling/startup-collector', () => ({ homeEmptyStartupOutcome: () => null }));

import HomeTab from '../index';
import { HOME_SECTIONS, focusedHomeLayout, homeSectionsStore } from '../../../../src/lib/home-sections';

function sectionOrder(): string[] {
  return screen.queryAllByTestId(/^section-/).map((element) => element.getAttribute('data-testid') ?? '');
}

function lastChrome() {
  return recorded.chrome.at(-1);
}

beforeEach(() => {
  settings.values.clear();
  homeSectionsStore.restoreDefaults();
  focus.hasBeenFocused = true;
  homeBoardState.board = null;
  homeBoardState.isResolving = false;
  recorded.crewFeedEnabled = [];
  recorded.sessionFeedEnabled = [];
  recorded.railProps = [];
  recorded.betaProps = [];
  recorded.chrome = [];
  recorded.customizeSheet = [];
  recorded.selectScopeIndex = null;
  refresh.onRefresh = null;
  refresh.refreshing = false;
  refresh.invalidateQueries.mockClear();
  refresh.invalidateQueries.mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  cleanup();
});

describe('Home sections', () => {
  it("draws today's Home by default: Climbing now, then the feed", () => {
    render(createElement(HomeTab));
    expect(sectionOrder()).toEqual(['section-climbingNow']);
    expect(recorded.railProps.at(-1)?.showStartPrompt).toBe(true);
    expect(screen.getByText('mobile.home.feedTitle')).toBeTruthy();
    expect(screen.getByTestId('home-customize')).toBeTruthy();
    expect(recorded.crewFeedEnabled.at(-1)).toBe(true);
    expect(lastChrome()?.showScopeMenu).toBe(true);
    expect(lastChrome()?.scopeActions.length).toBeGreaterThan(0);
    expect(lastChrome()?.scopeTitle).toBe('mobile.home.scope.myCrew');
  });

  it('Focused mounts the three cards and asks for no feed and no Climbing now', () => {
    homeSectionsStore.apply(focusedHomeLayout(homeSectionsStore.getLayout()));
    render(createElement(HomeTab));
    expect(sectionOrder()).toEqual(['section-board', 'section-session', 'section-playlists']);
    expect(recorded.railProps).toEqual([]);
    expect(recorded.crewFeedEnabled.every((enabled) => !enabled)).toBe(true);
    expect(recorded.sessionFeedEnabled.every((enabled) => !enabled)).toBe(true);
    expect(screen.queryByText('mobile.home.feedTitle')).toBeNull();
    // Nothing to scope: a plain "Home" title, header buttons kept.
    expect(lastChrome()).toEqual({ showScopeMenu: false, scopeTitle: 'mobile.nav.home', scopeActions: [] });
  });

  it('draws the sections in the order the climber chose', () => {
    homeSectionsStore.apply({
      order: ['playlists', 'climbingNow', 'board', 'session', 'feed'],
      visible: { ...HOME_SECTIONS.defaults.visible, playlists: true, board: true },
    });
    render(createElement(HomeTab));
    expect(sectionOrder()).toEqual(['section-playlists', 'section-climbingNow', 'section-board']);
  });

  it('keeps Start out of Climbing now while the Session card shows', () => {
    homeSectionsStore.setVisible('session', true);
    render(createElement(HomeTab));
    expect(sectionOrder()).toEqual(['section-session', 'section-climbingNow']);
    expect(recorded.railProps.at(-1)?.showStartPrompt).toBe(false);
  });

  it('holds the cards back until Home is first opened', () => {
    homeSectionsStore.apply(focusedHomeLayout(homeSectionsStore.getLayout()));
    focus.hasBeenFocused = false;
    const { rerender } = render(createElement(HomeTab));
    expect(sectionOrder()).toEqual([]);
    focus.hasBeenFocused = true;
    rerender(createElement(HomeTab));
    expect(sectionOrder()).toEqual(['section-board', 'section-session', 'section-playlists']);
  });

  it('shows the empty state with everything off, and Customize opens the sheet from there', () => {
    homeSectionsStore.setAllVisible(false);
    render(createElement(HomeTab));
    expect(sectionOrder()).toEqual([]);
    expect(screen.queryByTestId('home-customize')).toBeNull();
    expect(screen.getByText('mobile.home.sections.empty.title')).toBeTruthy();
    expect(recorded.customizeSheet).toEqual([]);
    act(() => {
      fireEvent.click(screen.getByTestId('home-empty-customize'));
    });
    expect(recorded.customizeSheet.at(-1)).toBe(true);
  });

  it('redraws as soon as the layout changes', () => {
    render(createElement(HomeTab));
    act(() => {
      fireEvent.click(screen.getByTestId('home-customize'));
    });
    expect(recorded.customizeSheet.at(-1)).toBe(true);
    act(() => {
      homeSectionsStore.setVisible('board', true);
    });
    expect(sectionOrder()).toEqual(['section-board', 'section-climbingNow']);
  });

  it('pull to refresh asks again only for what is on screen', () => {
    const { unmount } = render(createElement(HomeTab));
    act(() => refresh.onRefresh?.());
    expect(refresh.invalidateQueries.mock.calls.map(([filters]) => filters)).toEqual([{ queryKey: ['followed'] }]);
    unmount();

    refresh.invalidateQueries.mockClear();
    homeSectionsStore.apply(focusedHomeLayout(homeSectionsStore.getLayout()));
    render(createElement(HomeTab));
    act(() => refresh.onRefresh?.());
    expect(refresh.invalidateQueries.mock.calls.map(([filters]) => filters)).toEqual([
      { queryKey: ['sessionSummary'] },
      { queryKey: ['mySmartPlaylistCounts'] },
    ]);
  });

  it('keeps the spinner up while the cards refetch when the feed is hidden', async () => {
    let settle: () => void = () => {};
    refresh.invalidateQueries.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    homeSectionsStore.apply({
      ...HOME_SECTIONS.defaults,
      visible: { ...HOME_SECTIONS.defaults.visible, session: true, climbingNow: false, feed: false },
    });
    render(createElement(HomeTab));
    act(() => refresh.onRefresh?.());
    expect(refresh.refreshing).toBe(true);
    await act(async () => {
      settle();
    });
    expect(refresh.refreshing).toBe(false);
  });

  it('shows no spinner when nothing on screen has anything to fetch', () => {
    homeSectionsStore.apply({
      ...HOME_SECTIONS.defaults,
      visible: { ...HOME_SECTIONS.defaults.visible, board: true, climbingNow: false, feed: false },
    });
    render(createElement(HomeTab));
    act(() => refresh.onRefresh?.());
    expect(refresh.invalidateQueries).not.toHaveBeenCalled();
    expect(refresh.refreshing).toBe(false);
  });

  it('mounts Fresh beta only when it is switched on, scoped to the selected board', () => {
    render(createElement(HomeTab));
    expect(recorded.betaProps).toEqual([]);
    cleanup();
    homeSectionsStore.setVisible('beta', true);
    render(createElement(HomeTab));
    expect(sectionOrder()).toEqual(['section-climbingNow', 'section-beta']);
    // No home board resolved in this test, so the shelf is every board.
    expect(recorded.betaProps.at(-1)).toEqual({ boardType: null, layoutId: null, enabled: true });
    act(() => refresh.onRefresh?.());
    expect(refresh.invalidateQueries.mock.calls.map(([filters]) => filters)).toContainEqual({
      queryKey: ['recentBetaLinks'],
    });
  });

  it('asks Fresh beta once, for the home board, on a cold start that opens on Home', () => {
    homeBoardState.board = { uuid: 'board-1', boardType: 'kilter', layoutId: 8, name: 'Home wall', gymName: null };
    homeBoardState.isResolving = true;
    homeSectionsStore.setVisible('beta', true);
    const { rerender } = render(createElement(HomeTab));
    homeBoardState.isResolving = false;
    rerender(createElement(HomeTab));
    const asked = recorded.betaProps.filter((props) => props.enabled);
    expect(asked.length).toBeGreaterThan(0);
    // Never once for every board first: the board is set before the shelf may ask.
    expect(asked.every((props) => props.boardType === 'kilter' && props.layoutId === 8)).toBe(true);
  });

  it('moves Fresh beta to a new home board, until the climber picks a scope from the menu', () => {
    const kilter = { uuid: 'board-1', boardType: 'kilter', layoutId: 8, name: 'Home wall', gymName: null };
    const tension = { uuid: 'board-2', boardType: 'tension', layoutId: 10, name: 'Gym wall', gymName: null };
    const moon = { uuid: 'board-3', boardType: 'moonboard', layoutId: 4, name: 'Garage', gymName: null };
    homeBoardState.board = kilter;
    homeSectionsStore.setVisible('beta', true);
    const { rerender } = render(createElement(HomeTab));
    expect(recorded.betaProps.at(-1)).toEqual({ boardType: 'kilter', layoutId: 8, enabled: true });

    // Change board on Your board's card: the home board moves, and the scope with it.
    homeBoardState.board = tension;
    rerender(createElement(HomeTab));
    expect(recorded.betaProps.at(-1)).toEqual({ boardType: 'tension', layoutId: 10, enabled: true });

    // Everyone, picked from the scope menu, is the climber's own choice and stays.
    const actions = lastChrome()?.scopeActions as Array<{ label: string }>;
    const everyone = actions.findIndex((action) => action.label === 'mobile.home.scope.everyone');
    act(() => recorded.selectScopeIndex?.(everyone));
    expect(recorded.betaProps.at(-1)).toEqual({ boardType: null, layoutId: null, enabled: true });
    homeBoardState.board = moon;
    rerender(createElement(HomeTab));
    expect(recorded.betaProps.at(-1)).toEqual({ boardType: null, layoutId: null, enabled: true });
  });

  it('keeps the spinner up until the latest of two pulls settles', async () => {
    const settles: Array<() => void> = [];
    refresh.invalidateQueries.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settles.push(resolve);
        }),
    );
    homeSectionsStore.apply({
      ...HOME_SECTIONS.defaults,
      visible: { ...HOME_SECTIONS.defaults.visible, session: true, climbingNow: false, feed: false },
    });
    render(createElement(HomeTab));
    act(() => refresh.onRefresh?.());
    act(() => refresh.onRefresh?.());
    expect(settles).toHaveLength(2);
    expect(refresh.refreshing).toBe(true);
    await act(async () => {
      settles[0]();
    });
    // The first pull is done, the second is still out.
    expect(refresh.refreshing).toBe(true);
    await act(async () => {
      settles[1]();
    });
    expect(refresh.refreshing).toBe(false);
  });
});
