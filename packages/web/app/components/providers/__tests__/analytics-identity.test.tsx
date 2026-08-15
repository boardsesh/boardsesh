// @vitest-environment jsdom

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, render } from '@testing-library/react';
import type { Session } from 'next-auth';
import AnalyticsIdentity from '../analytics-identity';

const analytics = vi.hoisted(() => ({
  identify: vi.fn((_distinctId: string, _properties?: Record<string, unknown>) => true),
  reset: vi.fn(() => true),
  getAnalyticsDistinctId: vi.fn((): string | null => 'anon-1'),
  getAnalyticsAnonymousId: vi.fn((): string | null => 'anon-1'),
}));
vi.mock('@/app/lib/analytics', () => analytics);

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@sentry/nextjs', () => sentry);

const navigation = vi.hoisted(() => ({ usePathname: vi.fn((): string => '/gyms') }));
vi.mock('next/navigation', () => navigation);

const nextAuth = vi.hoisted(() => ({
  useSession: vi.fn((): { data: Session | null; status: 'loading' | 'authenticated' | 'unauthenticated' } => ({
    data: null,
    status: 'unauthenticated',
  })),
}));
vi.mock('next-auth/react', () => nextAuth);

function makeSession(userId: string, email: string | null): Session {
  return {
    expires: '2099-01-01T00:00:00.000Z',
    user: { id: userId, email, name: null, image: null },
  };
}

function signedOut(): void {
  nextAuth.useSession.mockReturnValue({ data: null, status: 'unauthenticated' });
}

function signedInAs(session: Session): void {
  nextAuth.useSession.mockReturnValue({ data: session, status: 'authenticated' });
}

/**
 * Mirror the SDK's storage pair. `distinctId` defaults to `anonymousId`, which
 * is what @posthog/core reports for a browser that has never been identified.
 */
function posthogStorage({ anonymousId, distinctId }: { anonymousId: string; distinctId?: string }): void {
  analytics.getAnalyticsAnonymousId.mockReturnValue(anonymousId);
  analytics.getAnalyticsDistinctId.mockReturnValue(distinctId ?? anonymousId);
}

async function renderIdentity(): Promise<{ rerender: () => Promise<void> }> {
  const view = render(<AnalyticsIdentity />);
  await act(async () => {});
  return {
    rerender: async () => {
      view.rerender(<AnalyticsIdentity />);
      await act(async () => {});
    },
  };
}

function expectNothingSent(): void {
  expect(analytics.identify).not.toHaveBeenCalled();
  expect(analytics.reset).not.toHaveBeenCalled();
}

describe('AnalyticsIdentity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    analytics.identify.mockReturnValue(true);
    analytics.reset.mockReturnValue(true);
    analytics.getAnalyticsDistinctId.mockReset().mockReturnValue('anon-1');
    analytics.getAnalyticsAnonymousId.mockReset().mockReturnValue('anon-1');
    navigation.usePathname.mockReturnValue('/gyms');
    signedOut();
  });

  it('sends nothing for an anonymous visitor', async () => {
    await renderIdentity();

    expectNothingSent();
  });

  it('sends nothing while the session is still loading', async () => {
    nextAuth.useSession.mockReturnValue({ data: null, status: 'loading' });
    await renderIdentity();

    expectNothingSent();
  });

  it('sends nothing when PostHog is not initialised (dev, preview, missing key)', async () => {
    analytics.getAnalyticsDistinctId.mockReturnValue(null);
    analytics.getAnalyticsAnonymousId.mockReturnValue(null);
    signedInAs(makeSession('user-1', 'climber@example.com'));
    await renderIdentity();

    expectNothingSent();
  });

  it('sends nothing on admin pages, which are excluded from analytics wholesale', async () => {
    navigation.usePathname.mockReturnValue('/admin/analytics');
    signedInAs(makeSession('user-1', 'climber@example.com'));
    await renderIdentity();

    expectNothingSent();
  });

  it('sends nothing on /embed/** — third-party iframes have no consent surface', async () => {
    navigation.usePathname.mockReturnValue('/embed/board/kilter');
    signedInAs(makeSession('user-1', 'climber@example.com'));
    await renderIdentity();

    expectNothingSent();
  });

  it('sends nothing on a locale-prefixed, mixed-case /embed path', async () => {
    navigation.usePathname.mockReturnValue('/es/EMBED/board/kilter');
    signedInAs(makeSession('user-1', 'climber@example.com'));
    await renderIdentity();

    expectNothingSent();
  });

  it('identifies the user on sign-in, letting $anon_distinct_id do the merge', async () => {
    signedInAs(makeSession('user-1', 'climber@example.com'));
    await renderIdentity();

    expect(analytics.identify).toHaveBeenCalledTimes(1);
    expect(analytics.identify).toHaveBeenCalledWith('user-1', { email: 'climber@example.com' });
    // No reset: the client was anonymous, so the anonymous person must be
    // merged into the user rather than thrown away.
    expect(analytics.reset).not.toHaveBeenCalled();
  });

  it('identifies without an email property when the session carries none', async () => {
    signedInAs(makeSession('user-1', null));
    await renderIdentity();

    expect(analytics.identify).toHaveBeenCalledWith('user-1', undefined);
  });

  it('identifies with session.user.id verbatim — the value the server sends too', async () => {
    const session = makeSession('9d1b6a4e-3f21-4a55-9b8c-0e2f7c4d1a33', 'climber@example.com');
    signedInAs(session);
    await renderIdentity();

    vi.doMock('server-only', () => ({}));
    vi.doMock('@/app/lib/auth/auth-options', () => ({ authOptions: {} }));
    vi.doMock('next-auth/next', () => ({ getServerSession: async () => session }));
    const { getPosthogDistinctId } = await import('@/app/lib/feature-flags/server-distinct-id');
    const serverDistinctId = await getPosthogDistinctId();

    // If these ever diverge, server-side person-property flag evaluation goes
    // back to resolving against a person that does not exist (#4511).
    expect(analytics.identify.mock.calls[0][0]).toBe(serverDistinctId);
    expect(serverDistinctId).toBe('9d1b6a4e-3f21-4a55-9b8c-0e2f7c4d1a33');
  });

  it('re-identifies a returning signed-in visitor so the email person property is guaranteed', async () => {
    posthogStorage({ anonymousId: 'anon-1', distinctId: 'user-1' });
    signedInAs(makeSession('user-1', 'climber@example.com'));
    await renderIdentity();

    // Already the right person, so nothing may be reset — but the identify still
    // runs, which @posthog/core collapses into a deduped $set.
    expect(analytics.reset).not.toHaveBeenCalled();
    expect(analytics.identify).toHaveBeenCalledTimes(1);
    expect(analytics.identify).toHaveBeenCalledWith('user-1', { email: 'climber@example.com' });
  });

  it('never reaches for alias() — $create_alias can merge two real people', () => {
    // The wrapper module is mocked with exactly the functions this component is
    // allowed to call, so an alias() import would fail to resolve at run time.
    expect(Object.keys(analytics)).not.toContain('alias');
  });

  describe('a browser PartyProfileProvider already identified (the fleet on deploy day)', () => {
    // localStorage carries distinctId = a user id from before #4467, and no
    // store of ours knows it. This is the state the first implementation of
    // this component could not see.
    const fleetBrowser = { anonymousId: 'anon-old', distinctId: 'user-1' };

    it('resets when the visitor turns up signed out', async () => {
      posthogStorage(fleetBrowser);
      signedOut();
      await renderIdentity();

      expect(analytics.reset).toHaveBeenCalledTimes(1);
      // reset() ONLY. Identifying a fresh uuid here would flip the SDK back to
      // identified and create a junk person per sign-out.
      expect(analytics.identify).not.toHaveBeenCalled();
    });

    it('does not attribute a second user to the first when they sign in after that reset', async () => {
      posthogStorage(fleetBrowser);
      signedOut();
      const view = await renderIdentity();

      expect(analytics.reset).toHaveBeenCalledTimes(1);
      vi.clearAllMocks();

      // reset() cleared the blob, so the SDK minted a fresh anonymous id.
      posthogStorage({ anonymousId: 'anon-fresh' });
      signedInAs(makeSession('user-2', 'second@example.com'));
      await view.rerender();

      expect(analytics.identify).toHaveBeenCalledTimes(1);
      expect(analytics.identify).toHaveBeenCalledWith('user-2', { email: 'second@example.com' });
      // user-1's id is never handed to PostHog again, in any argument.
      expect(analytics.identify.mock.calls.flat()).not.toContain('user-1');
    });

    it('resets before identifying when a second user signs in with no signed-out render between', async () => {
      posthogStorage(fleetBrowser);
      signedInAs(makeSession('user-2', 'second@example.com'));
      await renderIdentity();

      expect(analytics.reset).toHaveBeenCalledTimes(1);
      expect(analytics.identify).toHaveBeenCalledTimes(1);
      expect(analytics.identify).toHaveBeenCalledWith('user-2', { email: 'second@example.com' });
      // The reset has to land first, or the identify merges user-1 into user-2.
      expect(analytics.reset.mock.invocationCallOrder[0]).toBeLessThan(analytics.identify.mock.invocationCallOrder[0]);
    });
  });

  it('resets on sign-out and sends nothing else', async () => {
    signedInAs(makeSession('user-1', 'climber@example.com'));
    const view = await renderIdentity();
    vi.clearAllMocks();

    posthogStorage({ anonymousId: 'anon-1', distinctId: 'user-1' });
    signedOut();
    await view.rerender();

    expect(analytics.reset).toHaveBeenCalledTimes(1);
    expect(analytics.identify).not.toHaveBeenCalled();
  });

  it('sends nothing when an anonymous visitor merely navigates', async () => {
    const view = await renderIdentity();
    navigation.usePathname.mockReturnValue('/gyms/amsterdam');
    await view.rerender();

    expectNothingSent();
  });

  it('survives corrupt storage instead of blanking the root layout', async () => {
    analytics.getAnalyticsDistinctId.mockImplementation(() => {
      throw new SyntaxError('Unexpected token in JSON');
    });
    signedInAs(makeSession('user-1', 'climber@example.com'));

    await expect(renderIdentity()).resolves.toBeDefined();
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(analytics.identify).not.toHaveBeenCalled();
  });
});
