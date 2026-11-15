// @vitest-environment jsdom
import type { Context, ReactNode } from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardConfig } from '../../../providers/drawer-host-provider';
import type { Climb, Proposal } from '@boardsesh/shared-schema';
import type { HttpQueryScope } from '../../../lib/graphql/http-query-scope';

type RowActions = {
  proposal: Proposal;
  onOpenClimb: (proposal: Proposal) => void;
  onLongPressClimb: (proposal: Proposal) => unknown;
};
type PlaylistAction = (climb: Climb, config: BoardConfig) => void;
const selected = vi.hoisted(() => ({
  scope: null as HttpQueryScope | null,
  context: null as Context<HttpQueryScope | null> | null,
  rows: [] as RowActions[],
  refresh: null as null | (() => void),
  end: null as null | (() => void),
  playlist: null as null | PlaylistAction,
  open: vi.fn(),
  menu: vi.fn(),
  push: vi.fn(),
}));
vi.mock('../../../lib/graphql/use-http-query-scope', async () => {
  const { createContext, useContext } = await import('react');
  const context = createContext<HttpQueryScope | null>(null);
  selected.context = context;
  return { useHttpQueryScope: () => useContext(context)! };
});
vi.mock('../../../lib/graphql/use-auth-token', () => ({ useAuthToken: () => ({ data: 'owned-label' }) }));
vi.mock('../../../lib/client-platform', () => ({ CLIENT_PLATFORM: 'web' }));
vi.mock('../../../lib/connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: false, reason: null }),
  reportBackendOutcome: vi.fn(),
}));
vi.mock('../../../lib/screenshot-mode', () => ({ screenshotModeNextPageParam: (next: unknown) => next }));
vi.mock('react-native', () => ({
  Platform: { OS: 'web' },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  RefreshControl: ({ onRefresh }: { onRefresh: () => void }) => {
    selected.refresh = onRefresh;
    return null;
  },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const router = { push: (...args: unknown[]) => selected.push(...args) };
vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    data,
    renderItem,
    ListHeaderComponent,
    ListEmptyComponent,
    refreshControl,
    onEndReached,
  }: {
    data: Proposal[];
    renderItem: (row: { item: Proposal }) => ReactNode;
    ListHeaderComponent: ReactNode;
    ListEmptyComponent: ReactNode;
    refreshControl: ReactNode;
    onEndReached: () => void;
  }) => {
    selected.end = onEndReached;
    return (
      <div>
        {ListHeaderComponent}
        {refreshControl}
        {data.length ? data.map((item) => <div key={item.uuid}>{renderItem({ item })}</div>) : ListEmptyComponent}
      </div>
    );
  },
}));
const roles: ReadonlyArray<{ role: string; boardType: string | null }> = [];
vi.mock('../../../lib/graphql/hooks/use-my-roles', () => ({ useMyRoles: () => roles }));
vi.mock('../../../lib/graphql/use-active-board', () => ({ useActiveBoard: () => ({ data: { boardType: 'kilter' } }) }));
vi.mock('../../../providers/feature-flags-provider', () => ({ useClimbModerationEnabled: () => true }));
vi.mock('../../../lib/spray/use-spray-moderation', () => ({ useSprayModerationAccess: () => ({ canReview: true }) }));
vi.mock('../../../hooks/use-offline-query-state', () => ({
  useOfflineQueryState: () => ({ isBlocked: false, reason: null }),
}));
vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../lib/privacy/privacy-cache', () => ({
  getCredentialGeneration: () => 0,
  subscribeToCredentialChanges: () => () => {},
}));
vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({
    openPlayDrawer: selected.open,
    getClimbActions: (climb: Climb, config: BoardConfig, options: { openPlaylistInRoute: PlaylistAction }) => {
      selected.menu(climb, config);
      selected.playlist = options.openPlaylistInRoute;
      return [];
    },
  }),
}));
vi.mock('../../../lib/open-climb-in-play-drawer', () => ({
  openClimbInPlayDrawer: (...args: unknown[]) => selected.open(...args),
}));
vi.mock('../../../lib/playlists/board-details-for-playlist', () => ({
  getBoardConfigForPlaylist: () => ({ boardName: 'kilter', layoutId: 8, sizeId: 25, setIds: [1, 20] }),
}));
vi.mock('../../../lib/boards/default-angle', () => ({ defaultAngle: () => 40 }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {}, brandColors: {} }) }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 8: 32, 12: 48 } }));
vi.mock('../../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => <span>{children}</span> }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => <span>loading</span> }));
vi.mock('../../OfflineState', () => ({ OfflineState: () => <span>offline</span> }));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) => <button onClick={onPress}>{title}</button>,
}));
vi.mock('../../SegmentedControl', () => ({
  SegmentedControl: ({
    selectedKey,
    onSelect,
    options,
  }: {
    selectedKey: string;
    onSelect: (key: string) => void;
    options: { key: string; label: string }[];
  }) => (
    <div>
      {options.map((option) => (
        <button key={option.key} aria-pressed={selectedKey === option.key} onClick={() => onSelect(option.key)}>
          {option.label}
        </button>
      ))}
    </div>
  ),
}));
vi.mock('../ModerationProposalCard', () => ({
  ModerationProposalCard: (props: RowActions) => {
    selected.rows.push(props);
    return <span>{props.proposal.climbName}</span>;
  },
}));
vi.mock('../../AddToPlaylistSheet', () => ({
  AddToPlaylistSheet: ({ visible, climb }: { visible: boolean; climb: Climb }) => (
    <span>{visible ? `playlist-${climb.name}` : 'closed-playlist'}</span>
  ),
}));

import { createScopedHttpFixture } from '../../../lib/graphql/__tests__/fixtures/scoped-http';
import { ModerationFeedScreen } from '../ModerationFeedScreen';

const closers: (() => void)[] = [];
function proposal(name: string): Proposal {
  return {
    uuid: name,
    climbUuid: `climb-${name}`,
    climbName: name,
    boardType: 'kilter',
    layoutId: 8,
    angle: 40,
    frames: 'p1080r12',
    proposerId: 'owned-proposer',
    type: 'hide',
    proposedValue: 'true',
    currentValue: 'false',
    status: 'open',
    createdAt: '2026-09-01T10:00:00Z',
    weightedUpvotes: 1,
    weightedDownvotes: 0,
    requiredUpvotes: 3,
    userVote: 0,
    upvoterCount: 1,
    commentCount: 0,
  } as Proposal;
}
function page(name: string, hasMore = false) {
  return { data: { browseProposals: { proposals: [proposal(name)], totalCount: hasMore ? 2 : 1, hasMore } } };
}
function heldEnvelope(envelope: unknown) {
  let release!: () => void;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(envelope)));
        release = () => controller.close();
      },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  return { response, release: () => release() };
}
function fixture() {
  const http = createScopedHttpFixture();
  selected.scope = http.scope();
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const ScopeContext = selected.context!;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ScopeContext.Provider value={selected.scope}>
      <QueryClientProvider client={cache}>{children}</QueryClientProvider>
    </ScopeContext.Provider>
  );
  closers.push(() => {
    cache.clear();
    http.dispose();
  });
  return {
    ...http,
    cache,
    wrapper,
    change(kind: 'B' | 'ABA') {
      http.switchAccount('owned-B');
      if (kind === 'ABA') http.switchAccount('owned-A');
      selected.scope = http.scope();
    },
  };
}
beforeEach(() => {
  selected.rows = [];
  selected.playlist = null;
  selected.open.mockReset();
  selected.menu.mockReset();
  selected.push.mockReset();
});
afterEach(() => {
  cleanup();
  closers.splice(0).forEach((close) => close());
  selected.scope = null;
});

describe('actual moderation feed account ownership', () => {
  it.each(['B', 'ABA'] as const)('does not paint an old held feed body after %s', async (change) => {
    const current = fixture();
    const old = heldEnvelope(page('private-old-A'));
    const fresh = heldEnvelope(page('fresh-view'));
    current.performFetch.mockResolvedValueOnce(old.response).mockResolvedValueOnce(fresh.response);
    const screen = render(<ModerationFeedScreen />, current);
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledOnce());
    current.change(change);
    screen.rerender(<ModerationFeedScreen />);
    await waitFor(() => expect(current.performFetch).toHaveBeenCalledTimes(2));
    await act(async () => {
      old.release();
    });
    expect(screen.queryByText('private-old-A')).toBeNull();
    await act(async () => {
      fresh.release();
    });
    await waitFor(() => expect(screen.getByText('fresh-view')).toBeTruthy());
    expect(screen.queryByText('private-old-A')).toBeNull();
  });

  it.each(['B', 'ABA'] as const)(
    'retires row callbacks, menu handoffs, filters and playlist state after %s',
    async (change) => {
      const current = fixture();
      current.performFetch.mockImplementation(async () => Response.json(page('owned-row')));
      const screen = render(<ModerationFeedScreen />, current);
      await waitFor(() => expect(screen.getByText('owned-row')).toBeTruthy());
      const old = selected.rows.at(-1)!;
      act(() => {
        old.onOpenClimb(old.proposal);
        old.onLongPressClimb(old.proposal);
      });
      expect(selected.open).toHaveBeenCalledOnce();
      expect(selected.menu).toHaveBeenCalledOnce();
      const openPlaylist = selected.playlist!;
      const [climb, config] = selected.menu.mock.calls[0] as [Climb, BoardConfig];
      act(() => openPlaylist(climb, config));
      expect(screen.getByText('playlist-owned-row')).toBeTruthy();
      fireEvent.click(screen.getByText('mobile.moderation.filter.all'));
      expect(screen.getByText('mobile.moderation.filter.all').getAttribute('aria-pressed')).toBe('true');
      const refresh = selected.refresh!;
      const end = selected.end!;
      current.change(change);
      screen.rerender(<ModerationFeedScreen />);
      await waitFor(() => expect(screen.getByText('owned-row')).toBeTruthy());
      expect(screen.queryByText('playlist-owned-row')).toBeNull();
      expect(screen.getByText('mobile.moderation.filter.open').getAttribute('aria-pressed')).toBe('true');
      const requests = current.performFetch.mock.calls.length;
      act(() => {
        old.onOpenClimb(old.proposal);
        old.onLongPressClimb(old.proposal);
        openPlaylist(climb, config);
        refresh();
        end();
      });
      expect(selected.open).toHaveBeenCalledOnce();
      expect(selected.menu).toHaveBeenCalledOnce();
      expect(screen.queryByText('playlist-owned-row')).toBeNull();
      expect(current.performFetch).toHaveBeenCalledTimes(requests);
    },
  );

  it('preserves current filters, one-page pagination, preview and spray routing', async () => {
    const current = fixture();
    current.performFetch
      .mockResolvedValueOnce(Response.json(page('first-row', true)))
      .mockResolvedValueOnce(Response.json(page('second-row')))
      .mockResolvedValueOnce(Response.json(page('all-status-row')));
    const screen = render(<ModerationFeedScreen />, current);
    await waitFor(() => expect(screen.getByText('first-row')).toBeTruthy());
    expect(JSON.parse((current.performFetch.mock.calls[0][1] as RequestInit).body as string).variables).toEqual({
      input: { limit: 20, offset: 0, boardType: 'kilter', status: 'open' },
    });
    act(() => selected.end!());
    await waitFor(() => expect(screen.getByText('second-row')).toBeTruthy());
    expect(
      JSON.parse((current.performFetch.mock.calls[1][1] as RequestInit).body as string).variables.input.offset,
    ).toBe(1);
    expect(current.performFetch).toHaveBeenCalledTimes(2);
    const row = selected.rows.at(-1)!;
    act(() => row.onOpenClimb(row.proposal));
    expect(selected.open).toHaveBeenCalledWith(expect.objectContaining({ kind: 'climb' }), expect.anything(), {
      preview: true,
    });
    fireEvent.click(screen.getByText('sprayModeration.queueTitle'));
    expect(selected.push).toHaveBeenCalledWith('/moderation/spray-walls');
    fireEvent.click(screen.getByText('mobile.moderation.filter.all'));
    await waitFor(() => expect(screen.getByText('all-status-row')).toBeTruthy());
    expect(JSON.parse((current.performFetch.mock.calls[2][1] as RequestInit).body as string).variables.input).toEqual({
      limit: 20,
      offset: 0,
      boardType: 'kilter',
    });
  });
});
