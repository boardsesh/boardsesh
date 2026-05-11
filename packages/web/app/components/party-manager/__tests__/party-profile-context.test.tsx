import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PartyProfileProvider } from '../party-profile-context';

const mocks = vi.hoisted(() => ({
  alias: vi.fn(),
  clearPartyProfile: vi.fn(),
  ensurePartyProfile: vi.fn(),
  getPartyProfile: vi.fn(),
  hasRecordedPosthogAlias: vi.fn(),
  identify: vi.fn(),
  recordPosthogAlias: vi.fn(),
  reset: vi.fn(),
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

vi.mock('@/app/lib/analytics', () => ({
  alias: mocks.alias,
  identify: mocks.identify,
  reset: mocks.reset,
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
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ profile: null }),
      })),
    );
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
});
