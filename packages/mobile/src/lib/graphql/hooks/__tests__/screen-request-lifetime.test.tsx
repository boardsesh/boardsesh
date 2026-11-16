// @vitest-environment jsdom
/**
 * Notification, integration, climb-view and moderation requests outlive their
 * screen on phones (#7596 A4 group 4, the reverts of #7531, #7533, #7534,
 * #7535, #7537 and #7540).
 *
 * The reads are plain useQuery/useInfiniteQuery again: they never read
 * TanStack's abort signal, so a screen closed mid-fetch still fills the cache.
 * The writes are plain useMutation again: a follow-request answer, a mark-read,
 * a mark-all-read, an auto-sync toggle, a disconnect, a session export, a
 * proposal vote, a moderator's verdict or a climb report sent just before the
 * screen goes away still reaches the server, and its hook-level cache effect
 * (including an optimistic rollback on failure) still runs.
 *
 * Left out on purpose: useDeleteDraftClimb (its own test drives mutationFn and
 * onSuccess with no component at all, and it keeps the credential-generation
 * check it had before BA-05), and the export download, which aborts its file
 * save when the export screen unmounts, as it did before BA-05.
 *
 * Real HTTP through a local node:http server; see helpers/held-graphql-server.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import type { QueryClient } from '@tanstack/react-query';
import type { GraphQLClient } from 'graphql-request';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { GroupedNotification, GroupedNotificationConnection, Proposal } from '@boardsesh/shared-schema';
import {
  createHeldGraphQLServer,
  createScreenHost,
  expectReadOutlivesScreen,
  settleAfterUnmount,
  type ReadCase,
} from '../../__tests__/helpers/held-graphql-server';

const transport = vi.hoisted(() => ({ client: null as GraphQLClient | null }));
const analytics = vi.hoisted(() => ({ track: vi.fn() }));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('../../client', () => ({
  getHttpClient: () => {
    if (!transport.client) throw new Error('The local GraphQL server has not started');
    return transport.client;
  },
}));
vi.mock('../../use-auth-token', () => ({ useAuthToken: () => ({ data: 'token' }) }));
vi.mock('../../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../../../analytics', () => ({ track: analytics.track }));
vi.mock('../../../../hooks/use-current-user-id', () => ({
  useStoredUserId: () => ({ userId: 'me', isLoading: false }),
}));
vi.mock('../../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: toast.showToast }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
// expo-updates has no jsdom build; a report only forwards what this returns.
vi.mock('../../../release-context', () => ({
  readMobileReleaseContext: () => ({
    channel: null,
    branch: null,
    updateId: null,
    runtimeVersion: null,
    isEmbeddedLaunch: null,
  }),
}));

import {
  GROUPED_NOTIFICATIONS_QUERY_KEY,
  NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY,
  useAnswerFollowRequest,
  useGroupedNotifications,
  useMarkAllAsRead,
  useMarkGroupAsRead,
  useNotificationActors,
  useUnreadNotificationCount,
} from '../use-notifications';
import {
  useDisconnectIntegration,
  useIntegrationStatuses,
  useSetIntegrationAutoSync,
  useSyncSessionToIntegration,
} from '../use-integrations';
import { useBetaLinkPreview } from '../use-beta-link-preview';
import { useBoardRecentClimb } from '../use-board-recent-climb';
import { useFollowingClimbLogs } from '../use-following-climb-logs';
import { useRecentBetaLinks } from '../use-recent-beta-links';
import { LOGGED_SETTERS_PAGE_LIMIT, useUserLoggedSetters } from '../use-user-logged-setters';
import { browseProposalsKey, useBrowseProposals } from '../use-browse-proposals';
import { useVoteOnProposal } from '../use-vote-on-proposal';
import { useResolveProposal } from '../use-resolve-proposal';
import { useReportClimb } from '../use-report-climb';
import { NOTIFICATION_ACTORS_QUERY_KEY } from '../../notification-actors-key';
import { CLIMB_QUERY_KEY, followingClimbLogsQueryKey, recentBetaLinksQueryKey } from '../../query-keys';

const server = createHeldGraphQLServer();

beforeAll(async () => {
  transport.client = await server.start();
});

afterEach(() => {
  server.releaseAll();
  analytics.track.mockReset();
  toast.showToast.mockReset();
});

afterAll(async () => {
  transport.client = null;
  await server.stop();
});

function notificationGroup(overrides: Partial<GroupedNotification> = {}): GroupedNotification {
  return {
    uuid: 'group-1',
    type: 'new_follower',
    entityType: null,
    entityId: null,
    actorCount: 1,
    actors: [{ id: 'actor-1', displayName: 'Jo', avatarUrl: null }],
    commentBody: null,
    climbName: null,
    climbUuid: null,
    boardType: null,
    proposalUuid: null,
    setterUsername: null,
    gymName: null,
    isRead: false,
    createdAt: '2026-11-14T10:00:00.000Z',
    ...overrides,
  } as GroupedNotification;
}

function notificationPage(groups: GroupedNotification[], unreadCount: number): GroupedNotificationConnection {
  return { groups, totalCount: groups.length, unreadCount, hasMore: false };
}

const EMPTY_FEED = notificationPage([], 0);
const ACTORS_PAGE = { users: [], hasMore: false };
const STRAVA_OFF = {
  integrations: [{ provider: 'STRAVA', connected: true, autoSyncEnabled: false, externalAccountName: 'Ana' }],
};
const STRAVA_ON = {
  integrations: [{ provider: 'STRAVA', connected: true, autoSyncEnabled: true, externalAccountName: 'Ana' }],
};
const FOLLOWING_LOGS = { items: [], totalCount: 0 };
const SETTER = { setterUsername: 'route-setter', tickCount: 4 };
const PROPOSAL_PAGE = { proposals: [], totalCount: 0, hasMore: false };
const SETTERS_INPUT = { boardTypes: ['kilter'], layoutIds: [1], limit: LOGGED_SETTERS_PAGE_LIMIT };
const MODERATION_FEED_KEY = browseProposalsKey({ boardType: null, status: 'open' });
const OPEN_PROPOSAL = {
  uuid: 'proposal-1',
  climbUuid: 'climb-1',
  boardType: 'kilter',
  type: 'hide',
  status: 'open',
  weightedUpvotes: 1,
  weightedDownvotes: 0,
  requiredUpvotes: 3,
  userVote: 0,
  upvoterCount: 1,
} as Proposal;

/** The moderation feed's infinite-query envelope holding these proposals. */
function moderationFeed(proposals: Proposal[]) {
  return {
    pages: [{ browseProposals: { proposals, totalCount: proposals.length, hasMore: false } }],
    pageParams: [0],
  };
}

const READS: ReadCase[] = [
  {
    name: 'grouped notifications',
    operationName: 'GetGroupedNotifications',
    queryKey: GROUPED_NOTIFICATIONS_QUERY_KEY,
    data: { groupedNotifications: EMPTY_FEED },
    cached: { pages: [EMPTY_FEED], pageParams: [0] },
    mount: () => useGroupedNotifications(),
  },
  {
    name: 'unread notification count',
    operationName: 'GetUnreadNotificationCount',
    queryKey: NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY,
    data: { unreadNotificationCount: 3 },
    cached: 3,
    mount: () => useUnreadNotificationCount(),
  },
  {
    name: 'notification actors',
    operationName: 'GetNotificationActors',
    queryKey: [NOTIFICATION_ACTORS_QUERY_KEY, 'new_follower', null, null],
    data: { notificationActors: ACTORS_PAGE },
    cached: { pages: [ACTORS_PAGE], pageParams: [0] },
    mount: () => useNotificationActors('new_follower'),
  },
  {
    name: 'integration statuses',
    operationName: 'GetIntegrations',
    queryKey: ['integrationStatuses'],
    data: STRAVA_OFF,
    mount: () => useIntegrationStatuses(),
  },
  {
    name: 'beta link preview',
    operationName: 'BetaLinkPreview',
    queryKey: ['betaLinkPreview', 'https://example.com/beta'],
    data: { betaLinkPreview: null },
    mount: () => useBetaLinkPreview('https://example.com/beta'),
  },
  {
    name: 'board recent climb',
    operationName: 'BoardRecentClimbs',
    queryKey: ['boardRecentClimb', 7, null],
    data: { boardRecentClimbs: [] },
    mount: () => useBoardRecentClimb(7),
  },
  {
    name: 'climber logs from followed climbers',
    operationName: 'GetFollowingClimbAscents',
    queryKey: followingClimbLogsQueryKey('me', 'kilter', 'climb-1'),
    data: { followingClimbAscents: FOLLOWING_LOGS },
    mount: () => useFollowingClimbLogs('kilter', 'climb-1'),
  },
  {
    name: 'recent beta videos',
    operationName: 'GetRecentBetaLinks',
    queryKey: recentBetaLinksQueryKey(5, 'kilter', 1),
    data: { recentBetaLinks: [] },
    mount: () => useRecentBetaLinks(5, 'kilter', 1, true),
  },
  {
    name: 'logged setters',
    operationName: 'GetUserLoggedSetters',
    queryKey: ['userLoggedSetters', 'user-1', SETTERS_INPUT],
    data: { userLoggedSetters: [SETTER] },
    cached: [SETTER],
    mount: () => useUserLoggedSetters('user-1', { boardType: 'kilter', layoutIds: [1] }, ''),
  },
  {
    name: 'moderation feed',
    operationName: 'BrowseProposals',
    queryKey: browseProposalsKey({ boardType: null, status: 'open' }),
    data: { browseProposals: PROPOSAL_PAGE },
    cached: { pages: [{ browseProposals: PROPOSAL_PAGE }], pageParams: [0] },
    mount: () => useBrowseProposals({ boardType: null, status: 'open' }),
  },
];

describe('native notification, integration, climb-view and moderation reads outlive their screen', () => {
  it.each(READS)('$name: the answer lands in the cache after the screen unmounts', async (read) => {
    await expectReadOutlivesScreen(server, read);
  });
});

/** Resolves once the screen's one mutation has settled, whether or not the screen is still there. */
async function mutationSettled(queryClient: QueryClient, status: 'success' | 'error'): Promise<void> {
  await waitFor(() => expect(queryClient.getMutationCache().getAll()[0]?.state.status).toBe(status));
}

describe('native notification writes outlive the screen that started them', () => {
  it('follow request: the approval reaches the server and the row leaves the feed after the screen unmounts', async () => {
    const { queryClient, wrapper } = createScreenHost();
    const request = notificationGroup({ uuid: 'request-1', type: 'follow_request', entityId: 'requester-1' });
    const other = notificationGroup({ uuid: 'group-2' });
    queryClient.setQueryData(GROUPED_NOTIFICATIONS_QUERY_KEY, {
      pages: [notificationPage([request, other], 2)],
      pageParams: [0],
    });
    queryClient.setQueryData(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY, 2);

    const screen = renderHook(() => useAnswerFollowRequest(), { wrapper });
    let answered!: Promise<unknown>;
    act(() => {
      answered = screen.result.current({ notification: request, answer: 'approve' });
    });
    const held = await server.nextHeldRequest('ApproveFollowRequest');
    expect(held.variables).toEqual({ userId: 'requester-1' });

    screen.unmount();
    await settleAfterUnmount();
    expect(held.aborted).toBe(false);

    held.answer({ approveFollowRequest: true });
    await answered;
    await mutationSettled(queryClient, 'success');
    const feed = queryClient.getQueryData<{ pages: GroupedNotificationConnection[] }>(GROUPED_NOTIFICATIONS_QUERY_KEY);
    expect(feed?.pages[0].groups).toEqual([other]);
    expect(queryClient.getQueryData(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY)).toBe(1);
    expect(server.countOf('ApproveFollowRequest')).toBe(1);
  });

  it('mark read: the server gets it and the group reads as read after the screen unmounts', async () => {
    const { queryClient, wrapper } = createScreenHost();
    const unread = notificationGroup();
    queryClient.setQueryData(GROUPED_NOTIFICATIONS_QUERY_KEY, {
      pages: [notificationPage([unread], 5)],
      pageParams: [0],
    });
    queryClient.setQueryData(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY, 5);

    const screen = renderHook(() => useMarkGroupAsRead(), { wrapper });
    act(() => screen.result.current.mutate(unread));
    const held = await server.nextHeldRequest('MarkGroupNotificationsRead');

    screen.unmount();
    await settleAfterUnmount();
    expect(held.aborted).toBe(false);

    held.answer({ markGroupNotificationsRead: 4 });
    await mutationSettled(queryClient, 'success');
    expect(queryClient.getQueryData(GROUPED_NOTIFICATIONS_QUERY_KEY)).toEqual({
      pages: [notificationPage([{ ...unread, isRead: true }], 5)],
      pageParams: [0],
    });
    expect(queryClient.getQueryData(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY)).toBe(1);
  });
});

describe('native integration writes outlive the screen that started them', () => {
  it('auto-sync: the toggle reaches the server and keeps its answer after the screen unmounts', async () => {
    const { queryClient, wrapper } = createScreenHost();
    queryClient.setQueryData(['integrationStatuses'], STRAVA_OFF);

    const screen = renderHook(() => useSetIntegrationAutoSync(), { wrapper });
    act(() => screen.result.current.mutate({ provider: 'STRAVA', enabled: true }));
    const held = await server.nextHeldRequest('SetIntegrationAutoSync');
    expect(queryClient.getQueryData(['integrationStatuses'])).toEqual(STRAVA_ON);

    screen.unmount();
    await settleAfterUnmount();
    expect(held.aborted).toBe(false);

    held.answer({ setIntegrationAutoSync: STRAVA_ON.integrations[0] });
    await mutationSettled(queryClient, 'success');
    expect(queryClient.getQueryData(['integrationStatuses'])).toEqual(STRAVA_ON);
    expect(analytics.track).toHaveBeenCalledWith(SHARED_EVENTS.IntegrationAutoSyncToggled, {
      integration: 'strava',
      enabled: true,
    });
  });

  it('auto-sync: a refusal after the screen unmounts still rolls the switch back', async () => {
    const { queryClient, wrapper } = createScreenHost();
    queryClient.setQueryData(['integrationStatuses'], STRAVA_OFF);

    const screen = renderHook(() => useSetIntegrationAutoSync(), { wrapper });
    act(() => screen.result.current.mutate({ provider: 'STRAVA', enabled: true }));
    const held = await server.nextHeldRequest('SetIntegrationAutoSync');
    expect(queryClient.getQueryData(['integrationStatuses'])).toEqual(STRAVA_ON);

    screen.unmount();
    await settleAfterUnmount();
    expect(held.aborted).toBe(false);

    held.fail('Strava is not answering');
    await mutationSettled(queryClient, 'error');
    expect(queryClient.getQueryData(['integrationStatuses'])).toEqual(STRAVA_OFF);
    expect(queryClient.getQueryState(['integrationStatuses'])?.isInvalidated).toBe(true);
    expect(analytics.track).not.toHaveBeenCalled();
  });
});

describe('native moderation writes outlive the card that started them', () => {
  it('vote: a refusal after the card unmounts still puts the proposal back', async () => {
    const { queryClient, wrapper } = createScreenHost();
    const feed = moderationFeed([OPEN_PROPOSAL]);
    queryClient.setQueryData(MODERATION_FEED_KEY, feed);

    const card = renderHook(() => useVoteOnProposal(), { wrapper });
    act(() => card.result.current.mutate({ proposalUuid: 'proposal-1', value: 1 }));
    const held = await server.nextHeldRequest('VoteOnProposal');
    await waitFor(() => expect(queryClient.getQueryData(MODERATION_FEED_KEY)).not.toEqual(feed));

    card.unmount();
    await settleAfterUnmount();
    expect(held.aborted).toBe(false);

    held.fail('Voting is closed');
    await mutationSettled(queryClient, 'error');
    expect(queryClient.getQueryData(MODERATION_FEED_KEY)).toEqual(feed);
    expect(queryClient.getQueryState(MODERATION_FEED_KEY)?.isInvalidated).toBe(true);
    expect(server.countOf('VoteOnProposal')).toBe(1);
  });
});

/** One write a screen starts with a tap, and what it leaves behind once it lands. */
type WriteCase = {
  name: string;
  operationName: string;
  /** What the server answers. */
  data: unknown;
  /** The cache the screen was showing when the climber tapped. */
  seed?: (queryClient: QueryClient) => void;
  /** Mounts the screen's hook and returns the tap that sends the write. */
  mount: () => () => void;
  landed: (queryClient: QueryClient) => void;
};

const STRAVA_EXPORT = {
  provider: 'STRAVA',
  sessionId: 'session-1',
  externalActivityId: 'activity-1',
  externalActivityUrl: null,
  syncedAt: '2026-11-14T10:00:00.000Z',
  error: null,
};

const WRITES: WriteCase[] = [
  {
    name: 'mark all read',
    operationName: 'MarkAllNotificationsRead',
    data: { markAllNotificationsRead: true },
    seed: (queryClient) => {
      queryClient.setQueryData(GROUPED_NOTIFICATIONS_QUERY_KEY, {
        pages: [notificationPage([notificationGroup()], 3)],
        pageParams: [0],
      });
      queryClient.setQueryData(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY, 3);
    },
    mount: () => {
      const { mutate } = useMarkAllAsRead();
      return () => mutate();
    },
    landed: (queryClient) => {
      expect(queryClient.getQueryData(GROUPED_NOTIFICATIONS_QUERY_KEY)).toEqual({
        pages: [notificationPage([{ ...notificationGroup(), isRead: true }], 3)],
        pageParams: [0],
      });
      expect(queryClient.getQueryData(NOTIFICATIONS_UNREAD_COUNT_QUERY_KEY)).toBe(0);
    },
  },
  {
    name: 'disconnect Strava',
    operationName: 'DisconnectIntegration',
    data: { disconnectIntegration: true },
    seed: (queryClient) => queryClient.setQueryData(['integrationStatuses'], STRAVA_OFF),
    mount: () => {
      const { mutate } = useDisconnectIntegration();
      return () => mutate({ provider: 'STRAVA' });
    },
    landed: (queryClient) => {
      expect(queryClient.getQueryState(['integrationStatuses'])?.isInvalidated).toBe(true);
      expect(analytics.track).toHaveBeenCalledWith(SHARED_EVENTS.IntegrationDisconnected, { integration: 'strava' });
    },
  },
  {
    name: 'export a session to Strava',
    operationName: 'SyncSessionToIntegration',
    data: { syncSessionToIntegration: STRAVA_EXPORT },
    mount: () => {
      const { mutate } = useSyncSessionToIntegration();
      return () => mutate({ provider: 'STRAVA', sessionId: 'session-1' });
    },
    landed: () => {
      expect(analytics.track).toHaveBeenCalledWith(SHARED_EVENTS.SessionExportedToIntegration, {
        integration: 'strava',
        trigger: 'manual',
      });
    },
  },
  {
    name: "a moderator's approval",
    operationName: 'ResolveProposalFeed',
    data: { resolveProposal: { ...OPEN_PROPOSAL, status: 'approved' } },
    seed: (queryClient) => queryClient.setQueryData(MODERATION_FEED_KEY, moderationFeed([OPEN_PROPOSAL])),
    mount: () => {
      const { mutate } = useResolveProposal();
      return () => mutate({ proposalUuid: 'proposal-1', status: 'approved' });
    },
    landed: (queryClient) => {
      expect(queryClient.getQueryData(MODERATION_FEED_KEY)).toEqual(
        moderationFeed([{ ...OPEN_PROPOSAL, status: 'approved' }]),
      );
      expect(queryClient.getQueryState(MODERATION_FEED_KEY)?.isInvalidated).toBe(true);
      expect(toast.showToast).not.toHaveBeenCalled();
    },
  },
  {
    name: 'report a climb',
    operationName: 'ReportClimb',
    data: { reportClimb: { status: 'created', proposal: OPEN_PROPOSAL } },
    seed: (queryClient) => {
      queryClient.setQueryData(MODERATION_FEED_KEY, moderationFeed([]));
      queryClient.setQueryData([...CLIMB_QUERY_KEY, 'climb-1'], { uuid: 'climb-1' });
    },
    mount: () => {
      const { mutate } = useReportClimb();
      return () =>
        mutate({
          input: { climbUuid: 'climb-1', boardType: 'kilter', angle: null, kind: 'hide', reason: 'Duplicate climb' },
        });
    },
    landed: (queryClient) => {
      expect(queryClient.getQueryState(MODERATION_FEED_KEY)?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState([...CLIMB_QUERY_KEY, 'climb-1'])?.isInvalidated).toBe(true);
    },
  },
];

describe('native writes started with a tap outlive their screen', () => {
  it.each(WRITES)('$name: reaches the server and its cache effect runs after the screen unmounts', async (write) => {
    const { queryClient, wrapper } = createScreenHost();
    write.seed?.(queryClient);
    const screen = renderHook(write.mount, { wrapper });
    act(() => screen.result.current());
    const held = await server.nextHeldRequest(write.operationName);

    screen.unmount();
    await settleAfterUnmount();
    expect(held.aborted).toBe(false);

    held.answer(write.data);
    await mutationSettled(queryClient, 'success');
    write.landed(queryClient);
    expect(server.countOf(write.operationName)).toBe(1);
  });
});
