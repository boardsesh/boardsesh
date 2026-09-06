// @vitest-environment jsdom
//
// The connections screen serves three modes off one list, and the mode picks
// BOTH the query and the arguments it gets. The failure this pins is silent:
// a `newFollowers` list that asks for the wrong notification group returns an
// empty page rather than an error, so the screen renders its "no one new yet"
// placard and looks like it worked.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const params = vi.hoisted(() => ({ current: {} as Record<string, string | undefined> }));
const actorsCalls = vi.hoisted(() => ({ args: [] as unknown[][] }));
const followersCalls = vi.hoisted(() => ({ args: [] as unknown[][] }));
const followingCalls = vi.hoisted(() => ({ args: [] as unknown[][] }));

function idleQuery() {
  return {
    data: { pages: [{ users: [], totalCount: 0, hasMore: false }] },
    isPending: false,
    isError: false,
    isRefetching: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    status: 'success',
    fetchStatus: 'idle',
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
  };
}

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  RefreshControl: () => createElement('div', null),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  Platform: { OS: 'ios' },
}));

vi.mock('@shopify/flash-list', () => ({
  FlashList: () => createElement('div', { 'data-list': 'true' }),
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => params.current,
  useNavigation: () => ({ setOptions: vi.fn() }),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('../../../src/lib/graphql/hooks', () => ({
  useFollowers: (...args: unknown[]) => {
    followersCalls.args.push(args);
    return idleQuery();
  },
  useFollowing: (...args: unknown[]) => {
    followingCalls.args.push(args);
    return idleQuery();
  },
  useProfile: () => ({ data: { id: 'me-123' } }),
  useToggleUserFollow: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
}));

vi.mock('../../../src/lib/graphql/hooks/use-notifications', () => ({
  useNotificationActors: (...args: unknown[]) => {
    actorsCalls.args.push(args);
    return idleQuery();
  },
}));

vi.mock('../../../src/hooks/use-offline-query-state', () => ({
  useOfflineQueryState: () => ({ isOffline: false, isBlocked: false, reason: null }),
}));
vi.mock('../../../src/hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../src/providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { background: '#fff', tertiaryLabel: '#999' },
    brandColors: { primary: '#6D28D9' },
  }),
}));
vi.mock('../../../src/theme/tokens', () => ({ spacing: { 4: 16, 5: 20, 8: 32, 16: 64 } }));
vi.mock('../../../src/components/Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../src/components/Icon', () => ({ Icon: () => createElement('span', null) }));
vi.mock('../../../src/components/ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', null),
}));
vi.mock('../../../src/components/OfflineState', () => ({ OfflineState: () => createElement('div', null) }));
vi.mock('../../../src/components/you/ClimberSearch', () => ({
  ClimberSearchErrorState: () => createElement('div', null),
  ClimberSearchPersonRow: () => createElement('div', null),
}));

import ConnectionsScreen from '../connections';

beforeEach(() => {
  vi.clearAllMocks();
  actorsCalls.args = [];
  followersCalls.args = [];
  followingCalls.args = [];
});

describe('ConnectionsScreen mode routing', () => {
  it('asks for the notification group the row came from, not a null one', () => {
    // The regression: a follower notification's entityId is the FOLLOWED user's
    // id (never null), and `notificationActors` matches the group triple
    // exactly. Dropping it here matches no rows, and the follow-back list is
    // permanently empty with nothing to show for it.
    params.current = { mode: 'newFollowers', entityId: 'me-123' };

    render(<ConnectionsScreen />);

    const [type, entityType, entityId, enabled] = actorsCalls.args.at(-1)!;
    expect(type).toBe('new_follower');
    expect(entityType).toBeNull();
    expect(entityId).toBe('me-123');
    expect(enabled).toBe(true);
  });

  it('sends null rather than an empty string when the row carried no entity', () => {
    params.current = { mode: 'newFollowers', entityId: '' };

    render(<ConnectionsScreen />);

    expect(actorsCalls.args.at(-1)![2]).toBeNull();
  });

  it('enables exactly one query per mode', () => {
    params.current = { mode: 'newFollowers', entityId: 'me-123' };
    render(<ConnectionsScreen />);
    expect(actorsCalls.args.at(-1)![3]).toBe(true);
    expect(followersCalls.args.at(-1)![1]).toBe(false);
    expect(followingCalls.args.at(-1)![1]).toBe(false);

    actorsCalls.args = [];
    params.current = { userId: 'u9', mode: 'followers' };
    render(<ConnectionsScreen />);
    expect(followersCalls.args.at(-1)![1]).toBe(true);
    expect(actorsCalls.args.at(-1)![3]).toBe(false);

    params.current = { userId: 'u9', mode: 'following' };
    render(<ConnectionsScreen />);
    expect(followingCalls.args.at(-1)![1]).toBe(true);
  });

  it('defaults an unknown mode to followers', () => {
    params.current = { userId: 'u9', mode: 'nonsense' };

    render(<ConnectionsScreen />);

    expect(followersCalls.args.at(-1)![1]).toBe(true);
  });
});
