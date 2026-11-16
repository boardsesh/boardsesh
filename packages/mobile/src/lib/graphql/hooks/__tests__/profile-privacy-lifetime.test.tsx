// @vitest-environment jsdom
/**
 * Profile, admin, roles and privacy requests outlive their screen on phones
 * (#7596 A4, the reverts of #7521, #7528 and #7530). useProfile, useIsAdmin
 * and useMyRoles never read TanStack's abort signal again, so a screen closed
 * mid-fetch still fills the cache; useUpdateProfile and usePrivacyFollowAction
 * are plain useMutation hooks, so a save or follow sent from a screen reaches
 * the server and edits the cache after the screen is gone, and their mutate
 * keeps one identity across renders.
 *
 * Real HTTP through a local node:http server; see helpers/held-graphql-server.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import type { GraphQLClient } from 'graphql-request';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createHeldGraphQLServer,
  createScreenHost,
  expectReadOutlivesScreen,
  settleAfterUnmount,
  type ReadCase,
} from '../../__tests__/helpers/held-graphql-server';

const transport = vi.hoisted(() => ({ client: null as GraphQLClient | null }));
vi.mock('../../client', () => ({
  getHttpClient: () => {
    if (!transport.client) throw new Error('The local GraphQL server has not started');
    return transport.client;
  },
}));
// useProfile lives in the hooks barrel. It re-exports siblings that reach
// react-native, expo and the native credential store. None of them is on the
// path of the requests below; they are stubbed only so the barrel loads.
vi.mock('react-native', () => ({}));
vi.mock('../../../auth-store', () => ({
  getAuthToken: async () => 'native-token',
  captureAuthCredentialGeneration: () => 1,
  isAuthCredentialGenerationCurrent: () => true,
}));
vi.mock('../../use-auth-token', () => ({ useAuthToken: () => ({ data: 'native-token' }) }));
vi.mock('../../../connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: false }),
}));
vi.mock('../use-similar-climbs', () => ({ useSimilarClimbs: vi.fn() }));
vi.mock('../use-mobile-climb-actions-data', () => ({ useMobileClimbActionsData: vi.fn() }));
vi.mock('../use-you-profile-data', () => ({}));
vi.mock('../use-integrations', () => ({}));

import { useProfile, useUpdateProfile } from '../index';
import { useIsAdmin } from '../use-is-admin';
import { MY_ROLES_QUERY_KEY, useMyRoles } from '../use-my-roles';
import { usePrivacyFollowAction, useSetContentAudience } from '../use-privacy';

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

const PROFILE = { id: 'user-1', email: 'climber@example.test', displayName: 'Climber', avatarUrl: null };

const READS: ReadCase[] = [
  {
    name: 'profile',
    operationName: 'GetProfile',
    queryKey: ['profile'],
    data: { profile: PROFILE },
    mount: () => useProfile(),
  },
  {
    name: 'admin flag',
    operationName: 'ProfileAdminFlag',
    queryKey: ['profileAdminFlag'],
    data: { profile: { id: 'user-1', isAdmin: false } },
    mount: () => useIsAdmin(),
  },
  {
    name: 'community roles',
    operationName: 'GetMyRoles',
    queryKey: MY_ROLES_QUERY_KEY,
    data: { myRoles: [] },
    cached: [],
    mount: () => useMyRoles(),
  },
];

describe('native reads outlive the screen that started them', () => {
  it.each(READS)('$name: the answer lands in the cache after the screen unmounts', async (read) => {
    await expectReadOutlivesScreen(server, read);
  });
});

describe('native writes outlive the screen that started them', () => {
  it('a profile save reaches the server and updates the cached profile after the screen is gone', async () => {
    const { queryClient, wrapper } = createScreenHost();
    queryClient.setQueryData(['profile'], { profile: PROFILE });

    const screen = renderHook(() => useUpdateProfile(), { wrapper });
    act(() => {
      screen.result.current.mutate({ displayName: 'Renamed' });
    });
    const held = await server.nextHeldRequest('UpdateProfile');
    expect(held.variables).toEqual({ input: { displayName: 'Renamed' } });

    screen.unmount();
    await settleAfterUnmount();
    expect(held.aborted).toBe(false);

    held.answer({ updateProfile: { ...PROFILE, displayName: 'Renamed' } });
    await waitFor(() => expect(queryClient.getMutationCache().getAll()[0]?.state.status).toBe('success'));
    expect(queryClient.getQueryData(['profile'])).toEqual({ profile: { ...PROFILE, displayName: 'Renamed' } });
    expect(server.countOf('UpdateProfile')).toBe(1);
  });

  it('a follow request reaches the server and settles after the screen is gone', async () => {
    const { queryClient, wrapper } = createScreenHost();

    const screen = renderHook(() => usePrivacyFollowAction(), { wrapper });
    act(() => {
      screen.result.current.mutate({ action: 'request', userId: 'user-2' });
    });
    const held = await server.nextHeldRequest('RequestFollow');
    expect(held.variables).toEqual({ userId: 'user-2' });

    screen.unmount();
    await settleAfterUnmount();
    expect(held.aborted).toBe(false);

    held.answer({ requestFollow: true });
    await waitFor(() => expect(queryClient.getMutationCache().getAll()[0]?.state.status).toBe('success'));
    expect(server.countOf('RequestFollow')).toBe(1);
  });

  it('follow and audience writes keep one mutate across renders, so list rows stay memoised', () => {
    const { wrapper } = createScreenHost();
    const screen = renderHook(() => ({ follow: usePrivacyFollowAction(), audience: useSetContentAudience() }), {
      wrapper,
    });
    const first = screen.result.current;

    screen.rerender();

    expect(screen.result.current.follow.mutate).toBe(first.follow.mutate);
    expect(screen.result.current.audience.mutate).toBe(first.audience.mutate);
  });
});
