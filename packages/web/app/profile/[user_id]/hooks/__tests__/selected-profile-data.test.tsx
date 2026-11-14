import React from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { Session } from 'next-auth';
import { createBrowserBackendClient } from '@boardsesh/auth-protocol/browser-backend-client';
import { readBrowserBackendSessionScope } from '@boardsesh/auth-protocol/browser-backend-session';
import type { BrowserBackendLeaseOwner } from '@boardsesh/auth-protocol/browser-backend-lease';
import type { UserProfile } from '../../utils/profile-constants';

const control = vi.hoisted(() => ({
  client: null as ReturnType<typeof createBrowserBackendClient> | null,
  session: null as Session | null,
  request: vi.fn(),
  message: vi.fn(),
}));
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: control.session, status: control.session ? 'authenticated' : 'unauthenticated' }),
}));
vi.mock('@/app/lib/auth/browser-backend-client', () => ({
  browserBackendClient: new Proxy({}, { get: (_target, name) => Reflect.get(control.client!, name) }),
}));
vi.mock('@/app/hooks/use-ws-auth-token', () => ({ useWsAuthToken: () => ({ token: 'owned-fixture-lease' }) }));
vi.mock('@/app/lib/graphql/client', () => ({ createGraphQLHttpClient: () => ({ request: control.request }) }));
vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: control.message }),
}));
vi.mock('@/app/hooks/use-grade-format', () => ({ useGradeFormat: () => ({ gradeFormat: 'v-grade' }) }));
import { useProfileData } from '../use-profile-data';

function session(userId = 'owner-a'): Session & { browserSelection: BrowserBackendLeaseOwner } {
  return {
    user: { id: userId },
    expires: '2099-01-01T00:00:00.000Z',
    authSessionId: `${userId}-login`,
    authGeneration: 3,
    browserSelection: {
      userId,
      authSessionId: `${userId}-login`,
      generation: 3,
      cursor: { bindingId: 'a'.repeat(64), version: 2 },
    },
  };
}
const publicProfile: UserProfile = {
  id: 'owner-a',
  email: undefined,
  name: 'Public climber name',
  image: null,
  profile: null,
  credentials: [],
  followerCount: 2,
  followingCount: 3,
  isFollowedByMe: false,
};
const privateProfile: UserProfile = {
  ...publicProfile,
  email: 'PRIVATE_EMAIL',
  credentials: [{ boardType: 'kilter', auroraUsername: 'PRIVATE_MAPPING' }],
};
function envelope(profile = privateProfile) {
  const observed = readBrowserBackendSessionScope(control.session);
  return { browserProfileVersion: 1, owner: observed.status === 'selected' ? observed.owner : null, profile };
}
let readProfile: ReturnType<typeof vi.fn<typeof fetch>>;
const clients: QueryClient[] = [];
function renderProfile(seed: UserProfile = publicProfile, publicServerView = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(queryClient);
  let currentSeed = seed;
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const rendered = renderHook(() => useProfileData('owner-a', { initialProfile: currentSeed, publicServerView }), {
    wrapper,
  });
  return {
    ...rendered,
    queryClient,
    replaceSeed(this: void, next: UserProfile) {
      currentSeed = next;
      rendered.rerender();
    },
  };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-13T12:00:00.000Z'));
  control.client = createBrowserBackendClient({
    ready: () => true,
    fetch: vi.fn<typeof fetch>(),
    endpoint: '/owned-unused-lease',
    now: () => 0,
    schedule: () => () => {},
  });
  control.session = session();
  control.request.mockReset().mockResolvedValue({
    userTicks: [],
    userProfileStats: { totalDistinctClimbs: 7, layoutStats: [] },
    userClimbPercentile: null,
  });
  control.message.mockReset();
  readProfile = vi.fn<typeof fetch>(async () => Response.json(envelope()));
  vi.stubGlobal('fetch', readProfile);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  for (const queryClient of clients.splice(0)) queryClient.clear();
  control.client?.dispose();
  control.client = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('selected profile cache admission', () => {
  it('keeps the public seed useful and refreshes immediately after actual acceptance', async () => {
    const { result } = renderProfile();
    expect(result.current.profile?.name).toBe('Public climber name');
    expect(result.current.isOwnProfile).toBe(false);
    expect(readProfile).not.toHaveBeenCalled();
    expect(control.request).not.toHaveBeenCalled();
    act(() => {
      control.client!.acceptSession(control.session);
    });
    await waitFor(() => expect(result.current.profile?.email).toBe('PRIVATE_EMAIL'));
    expect(readProfile).toHaveBeenCalledTimes(1);
    expect(Date.now()).toBe(Date.parse('2026-11-13T12:00:00.000Z'));
    expect(result.current.isOwnProfile).toBe(true);
  });
  it('hides private profile and statistics immediately on local retirement without manufacturing anonymity', async () => {
    control.client!.acceptSession(control.session);
    const { result } = renderProfile();
    await waitFor(() => expect(result.current.profile?.email).toBe('PRIVATE_EMAIL'));
    await waitFor(() => expect(result.current.statisticsSummary.totalAscents).toBe(7));
    act(() => control.client!.retire());
    expect(result.current.profile).toEqual(publicProfile);
    expect(result.current.isOwnProfile).toBe(false);
    expect(result.current.allBoardsTicks).toEqual({});
    expect(result.current.statisticsSummary.totalAscents).toBe(0);
    expect(control.client!.isAnonymous()).toBe(false);
  });
  it('a deferred old body cannot enter any live profile cache after retirement', async () => {
    control.client!.acceptSession(control.session);
    let bodyStarted!: () => void;
    const started = new Promise<void>((resolve) => (bodyStarted = resolve));
    let release!: () => void;
    const oldEnvelope = envelope();
    readProfile.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: null,
      json: async () => {
        bodyStarted();
        await new Promise<void>((resolve) => (release = resolve));
        return oldEnvelope;
      },
    } as Response);
    const { result, queryClient } = renderProfile();
    await started;
    act(() => control.client!.retire());
    await act(async () => release());
    expect(result.current.profile).toEqual(publicProfile);
    const profiles = queryClient.getQueryCache().findAll({ queryKey: ['userProfile', 'owner-a'] });
    for (const query of profiles) expect((query.state.data as UserProfile | undefined)?.email).toBeUndefined();
  });
  it('same-tuple ABA cannot restore an old body, cache or optimistic callback', async () => {
    control.client!.acceptSession(control.session);
    let release!: (response: Response) => void;
    readProfile.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const { result, rerender } = renderProfile();
    await waitFor(() => expect(release).toBeTypeOf('function'));
    const oldSetter = result.current.setProfile;
    act(() => {
      control.client!.acceptSession(session('owner-b'));
      control.session = session();
      control.client!.acceptSession(control.session);
    });
    rerender();
    await waitFor(() => expect(result.current.profile?.email).toBe('PRIVATE_EMAIL'));
    await act(async () => release(Response.json(envelope({ ...privateProfile, email: 'OLD_PRIVATE_EMAIL' }))));
    expect(result.current.profile?.email).toBe('PRIVATE_EMAIL');
    expect(() => oldSetter({ ...privateProfile, email: 'OLD_OPTIMISTIC_EMAIL' })).toThrow(
      'Profile authority is unavailable',
    );
    expect(result.current.profile?.email).toBe('PRIVATE_EMAIL');
  });
  it('a503 never becomes not-found or an anonymous/private fallback', async () => {
    control.client!.acceptSession(control.session);
    readProfile.mockResolvedValue(Response.json({ error: 'unavailable' }, { status: 503 }));
    const { result, queryClient } = renderProfile();
    await waitFor(() =>
      expect(
        queryClient.getQueryCache().find({ queryKey: ['userProfile', 'owner-a'], exact: false })?.state
          .fetchFailureCount,
      ).toBe(1),
    );
    expect(result.current.notFound).toBe(false);
    expect(result.current.profile).toEqual(publicProfile);
    expect(control.client!.isSessionCurrent(control.session)).toBe(true);
    expect(control.client!.isAnonymous()).toBe(false);
  });
  it('new public server props do not overwrite an already admitted private result', async () => {
    control.client!.acceptSession(control.session);
    const { result, replaceSeed } = renderProfile();
    await waitFor(() => expect(result.current.profile?.email).toBe('PRIVATE_EMAIL'));
    replaceSeed({ ...publicProfile, name: 'New public name' });
    expect(result.current.profile?.email).toBe('PRIVATE_EMAIL');
  });
  it('legacy owner seeds retain their existing freshness without a selected receipt', () => {
    control.session = { user: { id: 'owner-a' }, expires: '2099-01-01T00:00:00.000Z' };
    const { result } = renderProfile(privateProfile, false);
    expect(result.current.profile?.email).toBe('PRIVATE_EMAIL');
    expect(result.current.isOwnProfile).toBe(true);
    expect(readProfile).not.toHaveBeenCalled();
  });
});
