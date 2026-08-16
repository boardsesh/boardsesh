// @vitest-environment jsdom

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, render } from '@testing-library/react';
import type { Session } from 'next-auth';
import AnalyticsIdentity from '../analytics-identity';

const analytics = vi.hoisted(() => ({
  identify: vi.fn((_distinctId: string, _properties?: Record<string, unknown>) => true),
  alias: vi.fn((_newId: string) => true),
  reset: vi.fn(() => true),
  getAnalyticsDistinctId: vi.fn((): string | null => 'anon-1'),
}));
vi.mock('@/app/lib/analytics', () => analytics);

const navigation = vi.hoisted(() => ({ usePathname: vi.fn((): string => '/gyms') }));
vi.mock('next/navigation', () => navigation);

const nextAuth = vi.hoisted(() => ({
  useSession: vi.fn((): { data: Session | null; status: 'loading' | 'authenticated' | 'unauthenticated' } => ({
    data: null,
    status: 'unauthenticated',
  })),
}));
vi.mock('next-auth/react', () => nextAuth);

// In-memory stand-in for the IndexedDB-backed singleton. The real store's
// dedupe/persistence semantics have their own test
// (app/lib/__tests__/analytics-identity-store.test.ts); this keeps the provider
// test focused on which PostHog calls come out, in what order.
const identityStore = vi.hoisted(() => {
  let identifiedUserId: string | null = null;
  const aliasPairs = new Set<string>();
  return {
    seed(userId: string | null): void {
      identifiedUserId = userId;
      aliasPairs.clear();
    },
    aliasPairs,
    peekIdentifiedUserId: (): string | null => identifiedUserId,
    store: {
      hydrate: (): Promise<void> => Promise.resolve(),
      getIdentifiedUserId: (): string | null => identifiedUserId,
      setIdentifiedUserId: (userId: string | null): void => {
        identifiedUserId = userId;
      },
      aliasStore: {
        hasRecordedAlias: (anonymousId: string, userId: string): boolean => aliasPairs.has(`${anonymousId}->${userId}`),
        recordAlias: (anonymousId: string, userId: string): void => {
          aliasPairs.add(`${anonymousId}->${userId}`);
        },
      },
    },
  };
});
vi.mock('@/app/lib/analytics-identity-store', () => ({ analyticsIdentityStore: identityStore.store }));

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

async function renderIdentity(): Promise<{ rerender: () => Promise<void> }> {
  const view = render(<AnalyticsIdentity />);
  // Flush the store-hydration microtask that gates the identity effect.
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
  expect(analytics.alias).not.toHaveBeenCalled();
  expect(analytics.reset).not.toHaveBeenCalled();
}

describe('AnalyticsIdentity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    identityStore.seed(null);
    analytics.identify.mockReturnValue(true);
    analytics.alias.mockReturnValue(true);
    analytics.reset.mockReturnValue(true);
    analytics.getAnalyticsDistinctId.mockReturnValue('anon-1');
    navigation.usePathname.mockReturnValue('/gyms');
    signedOut();
  });

  it('sends nothing for an anonymous visitor', async () => {
    await renderIdentity();

    expectNothingSent();
    expect(identityStore.peekIdentifiedUserId()).toBe(null);
  });

  it('sends nothing while the session is still loading', async () => {
    nextAuth.useSession.mockReturnValue({ data: null, status: 'loading' });
    await renderIdentity();

    expectNothingSent();
  });

  it('sends nothing when PostHog is not initialised (dev, preview, missing key)', async () => {
    analytics.getAnalyticsDistinctId.mockReturnValue(null);
    signedInAs(makeSession('user-1', 'climber@example.com'));
    await renderIdentity();

    expectNothingSent();
    // Critically, it also must not record an identity that was never sent.
    expect(identityStore.peekIdentifiedUserId()).toBe(null);
  });

  it('sends nothing on admin pages, which are excluded from analytics wholesale', async () => {
    navigation.usePathname.mockReturnValue('/admin/analytics');
    signedInAs(makeSession('user-1', 'climber@example.com'));
    await renderIdentity();

    expectNothingSent();
    expect(identityStore.peekIdentifiedUserId()).toBe(null);
  });

  it('aliases the anonymous id onto the user id, then identifies, in that order', async () => {
    signedInAs(makeSession('user-1', 'climber@example.com'));
    await renderIdentity();

    expect(analytics.alias).toHaveBeenCalledTimes(1);
    expect(analytics.alias).toHaveBeenCalledWith('user-1');
    expect(analytics.identify).toHaveBeenCalledTimes(1);
    expect(analytics.identify).toHaveBeenCalledWith('user-1', { email: 'climber@example.com' });
    // alias() links the CURRENT (anonymous) distinct id to the new one, so it
    // has to run while the client is still anonymous — identify() first would
    // strand every pre-login event on the anonymous person.
    expect(analytics.alias.mock.invocationCallOrder[0]).toBeLessThan(analytics.identify.mock.invocationCallOrder[0]);
    expect(analytics.reset).not.toHaveBeenCalled();
    expect([...identityStore.aliasPairs]).toEqual(['anon-1->user-1']);
    expect(identityStore.peekIdentifiedUserId()).toBe('user-1');
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

  it('sends nothing for a returning signed-in visitor already identified as that user', async () => {
    identityStore.seed('user-1');
    analytics.getAnalyticsDistinctId.mockReturnValue('user-1');
    signedInAs(makeSession('user-1', 'climber@example.com'));
    await renderIdentity();

    expectNothingSent();
  });

  it('does not re-alias the same pair when the identity effect re-runs', async () => {
    signedInAs(makeSession('user-1', 'climber@example.com'));
    const view = await renderIdentity();

    analytics.getAnalyticsDistinctId.mockReturnValue('user-1');
    navigation.usePathname.mockReturnValue('/gyms/amsterdam');
    await view.rerender();

    expect(analytics.alias).toHaveBeenCalledTimes(1);
  });

  it('resets on sign-out and re-anchors on a fresh anonymous id', async () => {
    signedInAs(makeSession('user-1', 'climber@example.com'));
    const view = await renderIdentity();
    vi.clearAllMocks();

    analytics.getAnalyticsDistinctId.mockReturnValue('user-1');
    signedOut();
    await view.rerender();

    expect(analytics.reset).toHaveBeenCalledTimes(1);
    expect(analytics.identify).toHaveBeenCalledTimes(1);
    const [reanchoredDistinctId] = analytics.identify.mock.calls[0];
    // A fresh anonymous id, NOT the signed-out user's id: re-pinning that would
    // alias one anonymous id to two people on the next sign-in.
    expect(reanchoredDistinctId).not.toBe('user-1');
    expect(reanchoredDistinctId).not.toBe('anon-1');
    expect(analytics.reset.mock.invocationCallOrder[0]).toBeLessThan(analytics.identify.mock.invocationCallOrder[0]);
    expect(identityStore.peekIdentifiedUserId()).toBe(null);
  });

  it('does not leave the first user attached when a second user signs in on the same browser', async () => {
    signedInAs(makeSession('user-1', 'first@example.com'));
    const view = await renderIdentity();

    analytics.getAnalyticsDistinctId.mockReturnValue('user-1');
    signedOut();
    await view.rerender();
    const [rotatedAnonymousId] = analytics.identify.mock.calls[analytics.identify.mock.calls.length - 1];

    vi.clearAllMocks();
    analytics.getAnalyticsDistinctId.mockReturnValue(rotatedAnonymousId);
    signedInAs(makeSession('user-2', 'second@example.com'));
    await view.rerender();

    expect(analytics.alias).toHaveBeenCalledTimes(1);
    expect(analytics.alias).toHaveBeenCalledWith('user-2');
    expect(analytics.identify).toHaveBeenCalledTimes(1);
    expect(analytics.identify).toHaveBeenCalledWith('user-2', { email: 'second@example.com' });
    // The only anonymous id ever aliased to user-2 is the rotated one, so
    // PostHog has no reason to merge the two people.
    expect(identityStore.aliasPairs.has(`${rotatedAnonymousId}->user-2`)).toBe(true);
    expect(identityStore.aliasPairs.has('anon-1->user-2')).toBe(false);
    expect(identityStore.aliasPairs.has('user-1->user-2')).toBe(false);
    expect(identityStore.peekIdentifiedUserId()).toBe('user-2');
  });

  it('switches straight from one user to another without aliasing their ids together', async () => {
    identityStore.seed('user-1');
    analytics.getAnalyticsDistinctId.mockReturnValue('user-1');
    signedInAs(makeSession('user-2', 'second@example.com'));
    await renderIdentity();

    expect(analytics.reset).toHaveBeenCalledTimes(1);
    expect(analytics.alias).toHaveBeenCalledTimes(1);
    expect(analytics.alias).toHaveBeenCalledWith('user-2');
    const [anchoredAnonymousId] = analytics.identify.mock.calls[0];
    expect(anchoredAnonymousId).not.toBe('user-1');
    expect(analytics.identify).toHaveBeenLastCalledWith('user-2', { email: 'second@example.com' });
    expect([...identityStore.aliasPairs]).toEqual([`${anchoredAnonymousId}->user-2`]);
  });

  it('reconciles a cleared localStorage anonymous id back onto the signed-in person', async () => {
    // PostHog's own persistence was wiped but our IndexedDB record survived.
    identityStore.seed('user-1');
    analytics.getAnalyticsDistinctId.mockReturnValue('anon-regenerated');
    signedInAs(makeSession('user-1', 'climber@example.com'));
    await renderIdentity();

    expect(analytics.reset).not.toHaveBeenCalled();
    expect(analytics.alias).toHaveBeenCalledTimes(1);
    expect(analytics.alias).toHaveBeenCalledWith('user-1');
    expect([...identityStore.aliasPairs]).toEqual(['anon-regenerated->user-1']);
    expect(analytics.identify).toHaveBeenLastCalledWith('user-1', { email: 'climber@example.com' });
  });

  it('does not record the alias pair when the analytics wrapper dropped the call', async () => {
    analytics.alias.mockReturnValue(false);
    signedInAs(makeSession('user-1', 'climber@example.com'));
    await renderIdentity();

    expect([...identityStore.aliasPairs]).toEqual([]);
  });
});
