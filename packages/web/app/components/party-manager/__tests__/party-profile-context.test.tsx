import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PartyProfileProvider, usePartyProfile } from '../party-profile-context';

type OAuthMarker = { provider: string; flow: 'web' | 'native'; attempted_at: number };

const mocks = vi.hoisted(() => ({
  alias: vi.fn(),
  clearPartyProfile: vi.fn(),
  consumeFreshOAuthPending: vi.fn<() => Promise<OAuthMarker | null>>(),
  ensurePartyProfile: vi.fn(),
  getPartyProfile: vi.fn(),
  hasRecordedPosthogAlias: vi.fn(),
  identify: vi.fn(),
  recordPosthogAlias: vi.fn(),
  reset: vi.fn(),
  setPersonProperties: vi.fn(),
  track: vi.fn(),
  graphqlRequest: vi.fn(),
  wsAuthToken: { token: null as string | null, isLoading: false },
  route: {
    pathname: '/',
  },
  session: {
    data: null as { user?: { id?: string; email?: string | null; image?: string | null; name?: string | null } } | null,
    status: 'unauthenticated' as 'authenticated' | 'loading' | 'unauthenticated',
  },
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: mocks.session.data,
    status: mocks.session.status,
  }),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => mocks.route.pathname,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { language: 'en-US' } }),
}));

vi.mock('@/app/lib/analytics', () => ({
  alias: mocks.alias,
  identify: mocks.identify,
  reset: mocks.reset,
  setPersonProperties: mocks.setPersonProperties,
  track: mocks.track,
}));

vi.mock('@/app/lib/party-profile-db', () => ({
  clearPartyProfile: mocks.clearPartyProfile,
  ensurePartyProfile: mocks.ensurePartyProfile,
  getPartyProfile: mocks.getPartyProfile,
}));

vi.mock('@/app/lib/posthog-alias-storage', () => ({
  hasRecordedPosthogAlias: mocks.hasRecordedPosthogAlias,
  recordPosthogAlias: mocks.recordPosthogAlias,
}));

vi.mock('@/app/lib/oauth-pending-db', () => ({
  consumeFreshOAuthPending: mocks.consumeFreshOAuthPending,
}));

vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mocks.graphqlRequest }),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({
    token: mocks.wsAuthToken.token,
    isAuthenticated: !!mocks.wsAuthToken.token,
    isLoading: mocks.wsAuthToken.isLoading,
    error: null,
  }),
}));

function renderProvider() {
  return render(
    <PartyProfileProvider>
      <div />
    </PartyProfileProvider>,
  );
}

describe('PartyProfileProvider PostHog identity wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.route.pathname = '/';
    mocks.session.data = null;
    mocks.session.status = 'unauthenticated';
    mocks.alias.mockReturnValue(true);
    mocks.ensurePartyProfile.mockResolvedValue({ id: 'profile-1' });
    mocks.getPartyProfile.mockResolvedValue({ id: 'profile-1' });
    mocks.hasRecordedPosthogAlias.mockReturnValue(false);
    mocks.consumeFreshOAuthPending.mockResolvedValue(null);
    mocks.wsAuthToken.token = null;
    mocks.wsAuthToken.isLoading = false;
    mocks.graphqlRequest.mockResolvedValue({ profile: null });
  });

  it('identifies the IndexedDB profile before aliasing and identifying the authenticated user', async () => {
    mocks.session.status = 'authenticated';
    mocks.session.data = {
      user: {
        id: 'user-1',
        email: 'one@example.com',
        name: 'One',
      },
    };

    renderProvider();

    await waitFor(() => {
      expect(mocks.identify).toHaveBeenCalledWith('user-1', { email: 'one@example.com' });
    });

    expect(mocks.reset).not.toHaveBeenCalled();
    expect(mocks.identify.mock.calls).toEqual([['profile-1'], ['user-1', { email: 'one@example.com' }]]);
    expect(mocks.hasRecordedPosthogAlias).toHaveBeenCalledWith('profile-1', 'user-1');
    expect(mocks.alias).toHaveBeenCalledWith('user-1');
    expect(mocks.recordPosthogAlias).toHaveBeenCalledWith('profile-1', 'user-1');
  });

  it('resets before re-identifying the profile when the authenticated user changes', async () => {
    mocks.session.status = 'authenticated';
    mocks.session.data = {
      user: {
        id: 'user-1',
        email: 'one@example.com',
      },
    };
    const { rerender } = renderProvider();

    await waitFor(() => {
      expect(mocks.identify).toHaveBeenCalledWith('user-1', { email: 'one@example.com' });
    });

    mocks.alias.mockClear();
    mocks.hasRecordedPosthogAlias.mockClear();
    mocks.identify.mockClear();
    mocks.recordPosthogAlias.mockClear();
    mocks.reset.mockClear();

    mocks.session.data = {
      user: {
        id: 'user-2',
        email: null,
      },
    };
    rerender(
      <PartyProfileProvider>
        <div />
      </PartyProfileProvider>,
    );

    await waitFor(() => {
      expect(mocks.identify).toHaveBeenCalledWith('user-2', undefined);
    });

    expect(mocks.reset).toHaveBeenCalledTimes(1);
    expect(mocks.identify.mock.calls).toEqual([['profile-1'], ['user-2', undefined]]);
    expect(mocks.hasRecordedPosthogAlias).toHaveBeenCalledWith('profile-1', 'user-2');
    expect(mocks.alias).toHaveBeenCalledWith('user-2');
    expect(mocks.recordPosthogAlias).toHaveBeenCalledWith('profile-1', 'user-2');
  });

  it('fires Login Succeeded with provider when a fresh OAuth marker is present at authentication', async () => {
    mocks.consumeFreshOAuthPending.mockResolvedValue({
      provider: 'google',
      flow: 'web',
      attempted_at: Date.now(),
    });
    mocks.session.status = 'authenticated';
    mocks.session.data = {
      user: {
        id: 'user-3',
        email: 'three@example.com',
      },
    };

    renderProvider();

    await waitFor(() => {
      expect(mocks.track).toHaveBeenCalledWith('Login Succeeded', {
        auth_method: 'google',
        flow: 'web',
      });
    });
  });

  it('does not fire Login Succeeded when no OAuth marker exists', async () => {
    mocks.consumeFreshOAuthPending.mockResolvedValue(null);
    mocks.session.status = 'authenticated';
    mocks.session.data = {
      user: {
        id: 'user-4',
        email: 'four@example.com',
      },
    };

    renderProvider();

    await waitFor(() => {
      expect(mocks.identify).toHaveBeenCalledWith('user-4', { email: 'four@example.com' });
    });

    expect(mocks.track).not.toHaveBeenCalledWith('Login Succeeded', expect.anything());
  });

  it('attaches `language` once the IDB profile resolves, even for unauthenticated visitors', async () => {
    mocks.session.status = 'unauthenticated';
    mocks.session.data = null;

    renderProvider();

    await waitFor(() => {
      expect(mocks.setPersonProperties).toHaveBeenCalledWith({ language: 'en-US' });
    });
  });

  it('does not attach `language` on admin URLs', async () => {
    mocks.route.pathname = '/admin/retention';
    mocks.session.status = 'authenticated';
    mocks.session.data = {
      user: { id: 'user-5', email: 'five@example.com' },
    };

    renderProvider();

    // Give the effect a tick — the identity effect short-circuits on admin too,
    // so there's no other promise to await; flush microtasks via setImmediate.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.setPersonProperties).not.toHaveBeenCalled();
  });

  it('does not attach `language` while the IDB profile is still loading', async () => {
    let resolveProfile: (value: { id: string }) => void = () => {};
    mocks.ensurePartyProfile.mockReturnValue(
      new Promise((resolve) => {
        resolveProfile = resolve;
      }),
    );

    renderProvider();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.setPersonProperties).not.toHaveBeenCalled();

    // Resolve the profile to verify the effect fires once it's available.
    resolveProfile({ id: 'profile-1' });
    await waitFor(() => {
      expect(mocks.setPersonProperties).toHaveBeenCalledWith({ language: 'en-US' });
    });
  });
});

function ProfileConsumer() {
  const { username, avatarUrl } = usePartyProfile();
  return <div data-testid="consumer" data-username={username ?? ''} data-avatar-url={avatarUrl ?? ''} />;
}

describe('PartyProfileProvider custom-profile read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.route.pathname = '/';
    mocks.session.data = {
      user: { id: 'user-1', email: 'one@example.com', name: 'Session Name', image: 'session.png' },
    };
    mocks.session.status = 'authenticated';
    mocks.alias.mockReturnValue(true);
    mocks.ensurePartyProfile.mockResolvedValue({ id: 'profile-1' });
    mocks.getPartyProfile.mockResolvedValue({ id: 'profile-1' });
    mocks.hasRecordedPosthogAlias.mockReturnValue(true);
    mocks.consumeFreshOAuthPending.mockResolvedValue(null);
    mocks.wsAuthToken.token = null;
    mocks.wsAuthToken.isLoading = false;
    mocks.graphqlRequest.mockResolvedValue({
      profile: { displayName: 'Custom Name', avatarUrl: 'custom.png' },
    });
  });

  function renderConsumer() {
    return render(
      <PartyProfileProvider>
        <ProfileConsumer />
      </PartyProfileProvider>,
    );
  }

  // The resolver reads `profile` off the bearer token, so firing before
  // ws-auth resolves comes back null and flashes the NextAuth name/avatar.
  it('does not query before the ws-auth token resolves', async () => {
    renderConsumer();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.graphqlRequest).not.toHaveBeenCalled();
  });

  it('prefers the custom display name and avatar over the NextAuth session', async () => {
    mocks.wsAuthToken.token = 'ws-token';

    const { getByTestId } = renderConsumer();

    await waitFor(() => {
      expect(getByTestId('consumer').getAttribute('data-username')).toBe('Custom Name');
    });
    expect(getByTestId('consumer').getAttribute('data-avatar-url')).toBe('custom.png');
    expect(mocks.graphqlRequest).toHaveBeenCalled();
  });

  it('falls back to the session name and image when there is no custom profile', async () => {
    mocks.wsAuthToken.token = 'ws-token';
    mocks.graphqlRequest.mockResolvedValue({ profile: null });

    const { getByTestId } = renderConsumer();

    await waitFor(() => {
      expect(mocks.graphqlRequest).toHaveBeenCalled();
    });
    expect(getByTestId('consumer').getAttribute('data-username')).toBe('Session Name');
    expect(getByTestId('consumer').getAttribute('data-avatar-url')).toBe('session.png');
  });
});
