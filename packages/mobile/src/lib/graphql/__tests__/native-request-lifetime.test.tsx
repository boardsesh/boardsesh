// @vitest-environment jsdom
// Delivery metadata is covered by offline-write-context.test.ts; keep these unit tests native-free.
vi.mock('../../../offline/offline-write-context', () => ({
  readOfflineWriteRelease: () => ({
    platform: 'ios',
    appVersion: null,
    runtimeVersion: null,
    updateId: null,
    isEmbedded: null,
    branch: null,
  }),
  enqueueMeasuredMutation: async (...args: Parameters<typeof import('@boardsesh/offline-sync').enqueue>) =>
    (await import('@boardsesh/offline-sync')).enqueue(...args),
}));

/**
 * Native request lifetime (#7596 A4). On phones a read or a write started on a
 * screen finishes after that screen unmounts: nothing aborts it, and its cache
 * effect lands. This is the behaviour the store app shipped with before the
 * BA-05 per-call-site wrappers, and the plain hooks restored in A4 must keep it.
 *
 * The four reads pin behaviour rather than restore it: the BA-05 finite-query
 * wrapper never handed TanStack's signal over on native, so they already
 * finished after unmount. The disconnect case is the restored part: a plain
 * useMutation drops its per-call callbacks (the toast, router.back) once the
 * screen has gone, as it did before #7579. These hooks are plain TanStack again,
 * so #7599's per-operation account fence no longer covers them; sign-out's
 * `queryClient.clear()` is what keeps the old account's data out of the cache.
 *
 * Real HTTP: a local node:http server answers /graphql, and the hooks send
 * through a real `GraphQLClient` on the real `fetch`. Only the module that
 * builds the app's client is swapped, so its URL points at the local server.
 * The server holds every answer until the test releases it, after the unmount.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import type { GraphQLClient } from 'graphql-request';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GetMyConnectedAppsResponse } from '@boardsesh/graphql/operations/connected-apps';
import type { GetUserClimbsQueryResponse } from '@boardsesh/graphql/operations/social';
import {
  createHeldGraphQLServer,
  createScreenHost,
  expectReadOutlivesScreen,
  settleAfterUnmount,
  type ReadCase,
} from './helpers/held-graphql-server';

const transport = vi.hoisted(() => ({ client: null as GraphQLClient | null }));
vi.mock('../client', () => ({
  getHttpClient: () => {
    if (!transport.client) throw new Error('The local GraphQL server has not started');
    return transport.client;
  },
}));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
// The live-session rails poll only while their tab is focused.
vi.mock('expo-router', () => ({ useIsFocused: () => true }));

import { CONNECTED_APPS_QUERY_KEY, useDisconnectApp, useMyConnectedApps } from '../hooks/use-connected-apps';
import { useBetaLinks } from '../hooks/use-beta-links';
import { useClimbProposals } from '../hooks/use-climb-proposals';
import { climbProposalsKey } from '../hooks/use-browse-proposals';
import { CLIMB_LOST_HOLDS_QUERY_KEY, useClimbLostHolds } from '../hooks/use-climb-lost-holds';
import { useBoardLiveSessions, useFollowedLiveSessions } from '../hooks/use-live-sessions';
import { useSessionDetail, useSessionOwnerUserId, useSessionPreview } from '../hooks/use-session-detail';
import { useUserClimbs } from '../hooks/use-social';
import { boardLiveSessionsQueryKey, followedLiveSessionsQueryKey } from '../query-keys';

const server = createHeldGraphQLServer();

beforeAll(async () => {
  transport.client = await server.start();
});

afterEach(() => {
  server.releaseAll();
});

afterAll(async () => {
  transport.client = null;
  await server.stop();
});

const LOST_HOLDS_VARIABLES = {
  boardName: 'spray',
  layoutId: 9001,
  sizeId: 1,
  setIds: '1',
  angle: 40,
  climbUuid: 'climb-1',
};

const USER_CLIMBS_ANSWER: GetUserClimbsQueryResponse = {
  userClimbs: { climbs: [], totalCount: 0, hasMore: false },
};

const READS: ReadCase[] = [
  {
    name: 'connected apps',
    operationName: 'GetMyConnectedApps',
    queryKey: CONNECTED_APPS_QUERY_KEY,
    data: { myConnectedApps: { apps: [] } },
    mount: () => useMyConnectedApps(),
  },
  {
    name: 'beta videos',
    operationName: 'GetBetaLinks',
    queryKey: ['betaLinks', 'kilter', 'climb-1'],
    data: { betaLinks: [] },
    mount: () => useBetaLinks('kilter', 'climb-1'),
  },
  {
    name: 'climb proposals',
    operationName: 'GetClimbProposals',
    queryKey: climbProposalsKey('climb-1'),
    data: { climbProposals: { proposals: [], totalCount: 0, hasMore: false } },
    mount: () => useClimbProposals({ climbUuid: 'climb-1', boardType: 'kilter' }),
  },
  {
    name: 'lost holds',
    operationName: 'GetClimbLostHolds',
    queryKey: [...CLIMB_LOST_HOLDS_QUERY_KEY, LOST_HOLDS_VARIABLES],
    data: { climb: { uuid: 'climb-1', lostHolds: [] } },
    mount: () => useClimbLostHolds(LOST_HOLDS_VARIABLES),
  },
  // Group 2 (#7560): session reads. The board and gym reads (#7559) live in
  // hooks/__tests__/board-gym-read-lifetime.test.tsx, behind the hooks barrel.
  {
    name: 'followed live sessions',
    operationName: 'FollowedLiveSessions',
    queryKey: followedLiveSessionsQueryKey(null),
    data: { followedLiveSessions: [] },
    mount: () => useFollowedLiveSessions(null, true),
  },
  {
    name: 'board live sessions',
    operationName: 'BoardLiveSessions',
    queryKey: boardLiveSessionsQueryKey(7),
    data: { boardLiveSessions: [] },
    mount: () => useBoardLiveSessions(7, true),
  },
  {
    name: 'session detail',
    operationName: 'GetSessionDetail',
    queryKey: ['sessionDetail', 'session-1'],
    data: { sessionDetail: null },
    cached: null,
    mount: () => useSessionDetail('session-1'),
  },
  {
    name: 'session preview',
    operationName: 'GetSession',
    queryKey: ['sessionPreview', 'session-1'],
    data: { session: null },
    cached: null,
    mount: () => useSessionPreview('session-1'),
  },
  {
    name: 'session owner',
    operationName: 'GetSessionOwner',
    queryKey: ['sessionOwner', 'session-1'],
    data: { session: { id: 'session-1', createdByUserId: 'owner-1' } },
    cached: 'owner-1',
    mount: () => useSessionOwnerUserId('session-1'),
  },
  // Group 2 (#7561): the profile Created climbs list. Before #7599 its paged
  // wrapper read TanStack's signal on phones too, so leaving the profile
  // mid-fetch cancelled the read. It is a plain useInfiniteQuery again.
  {
    name: 'profile created climbs',
    operationName: 'GetUserClimbs',
    queryKey: ['userClimbs', 'user-1'],
    data: USER_CLIMBS_ANSWER,
    cached: { pages: [USER_CLIMBS_ANSWER.userClimbs], pageParams: [0] },
    mount: () => useUserClimbs('user-1'),
  },
];

describe('the local server', () => {
  it('sees a request the client aborts, so the checks below can fail', async () => {
    const controller = new AbortController();
    const sent = transport.client!.request({
      document: 'query AbortProbe { probe }',
      signal: controller.signal,
    });
    const settled = sent.then(
      () => 'answered',
      () => 'rejected',
    );
    const held = await server.nextHeldRequest('AbortProbe');
    controller.abort();
    expect(await settled).toBe('rejected');
    await waitFor(() => expect(held.aborted).toBe(true));
  });
});

describe('native reads outlive the screen that started them', () => {
  it.each(READS)('$name: the answer lands in the cache after the screen unmounts', async (read) => {
    await expectReadOutlivesScreen(server, read);
  });
});

describe('native writes outlive the screen that started them', () => {
  it('disconnect: the server gets it, the cache drops the app, and per-call callbacks follow TanStack', async () => {
    const { queryClient, wrapper } = createScreenHost();
    const app = { connectionId: 'connection-1', name: 'Sequence', publisherName: 'Sequence Ltd' };
    const kept = { connectionId: 'connection-2', name: 'DivePeaks', publisherName: 'DivePeaks AB' };
    queryClient.setQueryData(CONNECTED_APPS_QUERY_KEY, {
      myConnectedApps: { apps: [app, kept] },
    } as unknown as GetMyConnectedAppsResponse);
    const perCallSuccess = vi.fn();

    const screen = renderHook(() => useDisconnectApp(), { wrapper });
    act(() => {
      screen.result.current.mutate({ connectionId: app.connectionId }, { onSuccess: perCallSuccess });
    });
    const held = await server.nextHeldRequest('DisconnectApp');
    expect(held.variables).toEqual({ connectionId: app.connectionId });

    screen.unmount();
    await settleAfterUnmount();
    expect(held.aborted).toBe(false);

    held.answer({ disconnectApp: true });
    await waitFor(() => expect(queryClient.getMutationCache().getAll()[0]?.state.status).toBe('success'));
    // The hook's own onSuccess still edits the cache for the climber's next visit.
    expect(queryClient.getQueryData(CONNECTED_APPS_QUERY_KEY)).toEqual({ myConnectedApps: { apps: [kept] } });
    // A plain useMutation calls per-call callbacks only while its screen is
    // mounted; the BA-05 wrapper called them after the screen had gone.
    expect(perCallSuccess).not.toHaveBeenCalled();
    expect(server.countOf('DisconnectApp')).toBe(1);
  });
});
