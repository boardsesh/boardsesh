// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode, type RefObject } from 'react';
import type { Proposal } from '@boardsesh/shared-schema';

type BrowsePage = { browseProposals: { proposals: Proposal[]; totalCount: number; hasMore: boolean } };

type Query = {
  data?: { pages: BrowsePage[] };
  isPending: boolean;
  isError: boolean;
  isRefetching: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  status: 'pending' | 'error' | 'success';
  fetchStatus: 'fetching' | 'paused' | 'idle';
  refetch: () => void;
  fetchNextPage: () => void;
};

const fetchNextPage = vi.hoisted(() => vi.fn());
const refetch = vi.hoisted(() => vi.fn());
const scrollToIndex = vi.hoisted(() => vi.fn());

const state = vi.hoisted(() => ({
  query: null as unknown as Query,
  pinned: undefined as undefined | { climbProposals: { proposals: Proposal[] } },
  offline: { isOffline: false, isBlocked: false, reason: null as null | 'offline' | 'error' },
  moderationEnabled: true,
}));

// The inputs the screen hands each proposals hook. The kill-switch test reads
// them to prove the queries are gated OFF, not merely hidden behind a placard.
const browseInput = vi.hoisted(() => vi.fn());
const pinnedInput = vi.hoisted(() => vi.fn());

// The FlashList props the screen last handed down, so the perf test can compare
// `renderItem` / `keyExtractor` identities and the pagination test can fire
// `onEndReached` directly.
const list = vi.hoisted(() => ({
  renderItem: null as unknown,
  keyExtractor: null as unknown,
  onEndReached: null as null | (() => void),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// One stable handle, matching expo-router's module-level imperative api.
const routerMock = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', () => ({ useRouter: () => routerMock }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  RefreshControl: () => createElement('div', { 'data-refresh': 'true' }),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1, absoluteFill: {} },
}));

vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: {
    data?: Proposal[];
    renderItem: (info: { item: Proposal }) => ReactNode;
    keyExtractor: (proposal: Proposal) => string;
    ListHeaderComponent?: ReactNode;
    ListEmptyComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
    onEndReached?: () => void;
    ref?: RefObject<{ scrollToIndex: (options: unknown) => void } | null>;
  }) => {
    list.renderItem = props.renderItem;
    list.keyExtractor = props.keyExtractor;
    list.onEndReached = props.onEndReached ?? null;
    // React 19 passes `ref` as a plain prop to function components, so the
    // screen's `scrollToIndex` lands on this stub.
    if (props.ref) props.ref.current = { scrollToIndex };
    const rows = props.data ?? [];
    return createElement(
      'div',
      { 'data-list': 'true' },
      props.ListHeaderComponent,
      rows.length > 0
        ? rows.map((item) => createElement('div', { key: item.uuid }, props.renderItem({ item })))
        : props.ListEmptyComponent,
      props.ListFooterComponent,
    );
  },
}));

vi.mock('../../../lib/graphql/hooks/use-browse-proposals', () => ({
  useBrowseProposals: (input: unknown) => {
    browseInput(input);
    return state.query;
  },
  useClimbProposalsPinned: (input: unknown) => {
    pinnedInput(input);
    return { data: state.pinned };
  },
}));

vi.mock('../../../providers/feature-flags-provider', () => ({
  useClimbModerationEnabled: () => state.moderationEnabled,
}));

// Stable module-level values: an unstable roles array or auth object would churn
// `renderItem`, which is exactly what the perf test measures.
const ROLES: ReadonlyArray<{ role: string; boardType: string | null }> = [];
vi.mock('../../../lib/graphql/hooks/use-my-roles', () => ({ useMyRoles: () => ROLES }));

const activeBoardMock = vi.hoisted(() => ({ data: { boardType: 'kilter' } }));
vi.mock('../../../lib/graphql/use-active-board', () => ({ useActiveBoard: () => activeBoardMock }));

const authTokenMock = vi.hoisted(() => ({ data: 'token' }));
vi.mock('../../../lib/graphql/use-auth-token', () => ({ useAuthToken: () => authTokenMock }));

vi.mock('../../../hooks/use-offline-query-state', () => ({ useOfflineQueryState: () => state.offline }));
vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));

const drawerHostMock = vi.hoisted(() => ({ openPlayDrawer: vi.fn(), openClimbActions: vi.fn() }));
vi.mock('../../../providers/drawer-host-provider', () => ({ useDrawerHost: () => drawerHostMock }));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { background: '#fff', tertiaryLabel: '#999', label: '#000' },
    brandColors: { primary: '#6D28D9' },
  }),
}));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 8: 32, 12: 48 },
  borderRadius: { md: 8, lg: 12, full: 9999 },
}));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { systemRed: '#FF3B30' } }));

vi.mock('../../../lib/open-climb-in-play-drawer', () => ({ openClimbInPlayDrawer: vi.fn() }));
vi.mock('../../../lib/playlists/board-details-for-playlist', () => ({
  getBoardConfigForPlaylist: () => ({ boardName: 'kilter', layoutId: 8, sizeId: 25, setIds: [1, 20] }),
}));
vi.mock('../../../lib/boards/default-angle', () => ({ defaultAngle: () => 40 }));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-spinner': 'true' }),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));
vi.mock('../../OfflineState', () => ({
  OfflineState: ({ reason }: { reason: string }) => createElement('div', { 'data-offline': reason }),
}));
vi.mock('../../SegmentedControl', () => ({
  SegmentedControl: ({ selectedKey }: { selectedKey: string }) => createElement('div', { 'data-segment': selectedKey }),
}));
vi.mock('../ModerationProposalCard', () => ({
  ModerationProposalCard: ({ proposal, highlighted }: { proposal: Proposal; highlighted?: boolean }) =>
    createElement('div', { 'data-card': proposal.uuid, 'data-highlighted': highlighted ? 'yes' : 'no' }),
}));

import { ModerationFeedScreen } from '../ModerationFeedScreen';

function makeProposal(uuid: string): Proposal {
  return {
    uuid,
    climbUuid: `climb-${uuid}`,
    boardType: 'kilter',
    angle: 40,
    proposerId: 'u1',
    type: 'hide',
    proposedValue: 'true',
    currentValue: 'false',
    status: 'open',
    createdAt: '2026-09-01T10:00:00.000Z',
    weightedUpvotes: 1,
    weightedDownvotes: 0,
    requiredUpvotes: 3,
    userVote: 0,
    upvoterCount: 1,
    commentCount: 0,
    frames: 'p1080r12',
    layoutId: 8,
  } as Proposal;
}

function makePage(proposals: Proposal[], hasMore = false): BrowsePage {
  return { browseProposals: { proposals, totalCount: proposals.length, hasMore } };
}

function makeQuery(overrides: Partial<Query> = {}): Query {
  return {
    data: { pages: [makePage([])] },
    isPending: false,
    isError: false,
    isRefetching: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    status: 'success',
    fetchStatus: 'idle',
    refetch,
    fetchNextPage,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.query = makeQuery();
  state.pinned = undefined;
  state.offline = { isOffline: false, isBlocked: false, reason: null };
  state.moderationEnabled = true;
  list.renderItem = null;
  list.keyExtractor = null;
  list.onEndReached = null;
});

describe('ModerationFeedScreen states', () => {
  it('renders the empty placard when the queue came back empty', () => {
    const { container, queryByText } = render(<ModerationFeedScreen />);
    expect(queryByText('mobile.moderation.empty.title')).not.toBeNull();
    expect(container.querySelector('[data-spinner]')).toBeNull();
  });

  it('renders the spinner while pending, not the empty placard', () => {
    state.query = makeQuery({ data: undefined, isPending: true, status: 'pending', fetchStatus: 'fetching' });
    const { container, queryByText } = render(<ModerationFeedScreen />);
    expect(container.querySelector('[data-spinner]')).not.toBeNull();
    expect(queryByText('mobile.moderation.empty.title')).toBeNull();
  });

  it('renders OfflineState when the query is blocked with no data', () => {
    // `offlineFirst` PAUSES the query, so `isPending` never clears — a
    // spinner-only branch would hang forever.
    state.query = makeQuery({ data: undefined, isPending: true, status: 'pending', fetchStatus: 'paused' });
    state.offline = { isOffline: true, isBlocked: true, reason: 'offline' };
    const { container } = render(<ModerationFeedScreen />);
    expect(container.querySelector('[data-offline="offline"]')).not.toBeNull();
    expect(container.querySelector('[data-spinner]')).toBeNull();
  });

  it('renders the load error with a retry that refetches', () => {
    state.query = makeQuery({ data: undefined, isError: true, status: 'error' });
    const { getByText, queryByText } = render(<ModerationFeedScreen />);
    expect(queryByText('mobile.moderation.loadError')).not.toBeNull();

    fireEvent.click(getByText('actions.retry'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe('ModerationFeedScreen kill switch', () => {
  it('shows the unavailable placard and asks for nothing when the flag is off', () => {
    // Flipping `climb-moderation-kill` has to stop the FETCH, not just hide the
    // list: a queue that still loads while reporting is down is a queue nobody
    // is allowed to act on.
    state.moderationEnabled = false;
    state.query = makeQuery({ data: { pages: [makePage([makeProposal('p1')])] } });

    const { container, queryByText } = render(
      <ModerationFeedScreen highlightProposalUuid="p9" climbUuid="climb-p9" boardType="kilter" />,
    );

    expect(queryByText('mobile.moderation.unavailable.title')).not.toBeNull();
    expect(queryByText('mobile.moderation.unavailable.subtitle')).not.toBeNull();
    // No feed rendered, and both proposals queries gated off, so no
    // `browseProposals` request leaves the device.
    expect(container.querySelector('[data-list]')).toBeNull();
    expect(container.querySelector('[data-card="p1"]')).toBeNull();
    expect(browseInput).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    expect(pinnedInput).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('renders the feed with the query enabled when the flag is on', () => {
    state.query = makeQuery({ data: { pages: [makePage([makeProposal('p1')])] } });

    const { container, queryByText } = render(<ModerationFeedScreen />);

    expect(queryByText('mobile.moderation.unavailable.title')).toBeNull();
    expect(container.querySelector('[data-card="p1"]')).not.toBeNull();
    expect(browseInput).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });
});

describe('ModerationFeedScreen pagination', () => {
  it('fetches exactly one page per end-reach', () => {
    state.query = makeQuery({ data: { pages: [makePage([makeProposal('p1')], true)] }, hasNextPage: true });

    render(<ModerationFeedScreen />);
    list.onEndReached?.();
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('ignores an end-reach while a page is already in flight', () => {
    state.query = makeQuery({
      data: { pages: [makePage([makeProposal('p1')], true)] },
      hasNextPage: true,
      isFetchingNextPage: true,
    });

    render(<ModerationFeedScreen />);
    list.onEndReached?.();
    expect(fetchNextPage).not.toHaveBeenCalled();
  });
});

describe('ModerationFeedScreen deep links', () => {
  it('scrolls to the highlighted proposal once, not again on every page append', () => {
    const first = makeProposal('p1');
    const target = makeProposal('p2');
    state.query = makeQuery({ data: { pages: [makePage([first, target], true)] }, hasNextPage: true });

    const { rerender } = render(<ModerationFeedScreen highlightProposalUuid="p2" />);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    expect(scrollToIndex).toHaveBeenCalledWith({ index: 1, animated: true, viewPosition: 0.2 });

    // A second page lands. Re-scrolling here would yank the list back under a
    // climber who has already scrolled on.
    state.query = makeQuery({
      data: { pages: [makePage([first, target], true), makePage([makeProposal('p3')])] },
    });
    rerender(<ModerationFeedScreen highlightProposalUuid="p2" />);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
  });

  it('outlines the highlighted card and leaves the others plain', () => {
    state.query = makeQuery({ data: { pages: [makePage([makeProposal('p1'), makeProposal('p2')])] } });

    const { container } = render(<ModerationFeedScreen highlightProposalUuid="p2" />);
    expect(container.querySelector('[data-card="p2"]')?.getAttribute('data-highlighted')).toBe('yes');
    expect(container.querySelector('[data-card="p1"]')?.getAttribute('data-highlighted')).toBe('no');
  });

  it('pins a proposal the loaded pages do not carry', () => {
    // Page 6 of the queue: the notification's proposal is not in the feed yet,
    // so it is fetched by climb and shown above it.
    state.query = makeQuery({ data: { pages: [makePage([makeProposal('p1')])] } });
    state.pinned = { climbProposals: { proposals: [makeProposal('p9')] } };

    const { container, queryByText } = render(
      <ModerationFeedScreen highlightProposalUuid="p9" climbUuid="climb-p9" boardType="kilter" />,
    );
    expect(queryByText('mobile.moderation.pinnedFromNotification')).not.toBeNull();
    expect(container.querySelector('[data-card="p9"]')).not.toBeNull();
  });

  it('drops the pinned header once the proposal turns up in the pages', () => {
    // A later page (or a refetch) lands the row in the list while the pinned
    // query's answer is still cached. Rendering both puts the same card on
    // screen twice.
    state.query = makeQuery({ data: { pages: [makePage([makeProposal('p1'), makeProposal('p9')])] } });
    state.pinned = { climbProposals: { proposals: [makeProposal('p9')] } };

    const { container, queryByText } = render(
      <ModerationFeedScreen highlightProposalUuid="p9" climbUuid="climb-p9" boardType="kilter" />,
    );
    expect(queryByText('mobile.moderation.pinnedFromNotification')).toBeNull();
    expect(container.querySelectorAll('[data-card="p9"]')).toHaveLength(1);
  });
});

describe('ModerationFeedScreen perf checklist', () => {
  it('keeps renderItem and keyExtractor referentially stable across a page append', () => {
    const first = makeProposal('p1');
    state.query = makeQuery({ data: { pages: [makePage([first], true)] }, hasNextPage: true });

    const { rerender } = render(<ModerationFeedScreen />);
    const initialRenderItem = list.renderItem;
    const initialKeyExtractor = list.keyExtractor;
    expect(initialRenderItem).toBeTypeOf('function');

    state.query = makeQuery({
      data: { pages: [makePage([first], true), makePage([makeProposal('p2')])] },
    });
    rerender(<ModerationFeedScreen />);

    expect(list.renderItem).toBe(initialRenderItem);
    expect(list.keyExtractor).toBe(initialKeyExtractor);
  });
});
