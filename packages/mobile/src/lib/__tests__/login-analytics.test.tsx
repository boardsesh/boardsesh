// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

const analytics = vi.hoisted(() => ({ track: vi.fn() }));
const graphql = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('../analytics', () => ({ track: analytics.track }));
vi.mock('../graphql/client', () => ({ getHttpClient: () => ({ request: graphql.request }) }));
vi.mock('../graphql/operations', () => ({ GET_PROFILE: 'query GetProfile' }));

const {
  NEW_ACCOUNT_MAX_AGE_MS,
  PROFILE_READ_TIMEOUT_MS,
  accountAgeProperties,
  readAccountCreatedAt,
  useTrackLoginSucceeded,
} = await import('../login-analytics');

const SIGNED_IN_AT = new Date('2026-09-21T08:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

function isoBeforeSignIn(ageMs: number): string {
  return new Date(SIGNED_IN_AT.getTime() - ageMs).toISOString();
}

function createTestQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderTracker(queryClient: QueryClient) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return renderHook(() => useTrackLoginSucceeded(), { wrapper });
}

describe('accountAgeProperties', () => {
  it('calls an account made by this sign-in new, at zero hours', () => {
    expect(accountAgeProperties(isoBeforeSignIn(40_000), SIGNED_IN_AT.getTime())).toEqual({
      is_new_account: true,
      account_age_hours: 0,
    });
  });

  it('keeps an account new up to 24 hours and not a minute past', () => {
    expect(accountAgeProperties(isoBeforeSignIn(NEW_ACCOUNT_MAX_AGE_MS), SIGNED_IN_AT.getTime())).toEqual({
      is_new_account: true,
      account_age_hours: 24,
    });
    expect(
      accountAgeProperties(isoBeforeSignIn(NEW_ACCOUNT_MAX_AGE_MS + 60_000), SIGNED_IN_AT.getTime()).is_new_account,
    ).toBe(false);
  });

  it('reports a returning account with its age in tenths of an hour', () => {
    expect(accountAgeProperties(isoBeforeSignIn(30 * 24 * HOUR_MS + 0.26 * HOUR_MS), SIGNED_IN_AT.getTime())).toEqual({
      is_new_account: false,
      account_age_hours: 720.3,
    });
  });

  it('treats a creation time ahead of the phone clock as brand new', () => {
    expect(accountAgeProperties(isoBeforeSignIn(-5 * 60_000), SIGNED_IN_AT.getTime())).toEqual({
      is_new_account: true,
      account_age_hours: 0,
    });
  });

  it('adds nothing when the creation time is missing or unreadable', () => {
    expect(accountAgeProperties(null, SIGNED_IN_AT.getTime())).toEqual({});
    expect(accountAgeProperties(undefined, SIGNED_IN_AT.getTime())).toEqual({});
    expect(accountAgeProperties('not a date', SIGNED_IN_AT.getTime())).toEqual({});
  });
});

describe('readAccountCreatedAt', () => {
  beforeEach(() => {
    graphql.request.mockReset();
  });

  it('reuses a profile already in the cache instead of fetching again', async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(['profile'], { profile: { createdAt: '2026-09-20T08:00:00.000Z' } });

    await expect(readAccountCreatedAt(queryClient)).resolves.toBe('2026-09-20T08:00:00.000Z');
    expect(graphql.request).not.toHaveBeenCalled();
  });

  it('fetches the profile into the shared cache entry', async () => {
    const queryClient = createTestQueryClient();
    graphql.request.mockResolvedValue({ profile: { createdAt: '2026-09-21T07:59:00.000Z' } });

    await expect(readAccountCreatedAt(queryClient)).resolves.toBe('2026-09-21T07:59:00.000Z');
    expect(graphql.request).toHaveBeenCalledWith('query GetProfile');
    expect(queryClient.getQueryData(['profile'])).toEqual({ profile: { createdAt: '2026-09-21T07:59:00.000Z' } });
  });

  it('resolves null when the profile read fails', async () => {
    const queryClient = createTestQueryClient();
    graphql.request.mockRejectedValue(new Error('offline'));

    await expect(readAccountCreatedAt(queryClient)).resolves.toBeNull();
  });
});

describe('useTrackLoginSucceeded', () => {
  beforeEach(() => {
    analytics.track.mockReset();
    graphql.request.mockReset();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(SIGNED_IN_AT);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds is_new_account and backdates the event to the moment sign-in succeeded', async () => {
    graphql.request.mockImplementation(async () => {
      // The profile lands after the sign-in moment, as it does for real.
      vi.setSystemTime(SIGNED_IN_AT.getTime() + 800);
      return { profile: { createdAt: isoBeforeSignIn(20_000) } };
    });
    const { result } = renderTracker(createTestQueryClient());

    await act(async () => {
      result.current({ auth_method: 'google', flow: 'native' });
      await vi.runAllTimersAsync();
    });

    expect(analytics.track).toHaveBeenCalledTimes(1);
    expect(analytics.track).toHaveBeenCalledWith(
      'Login Succeeded',
      { auth_method: 'google', flow: 'native', is_new_account: true, account_age_hours: 0 },
      { timestamp: SIGNED_IN_AT },
    );
  });

  it('marks a returning account as not new', async () => {
    graphql.request.mockResolvedValue({ profile: { createdAt: isoBeforeSignIn(400 * 24 * HOUR_MS) } });
    const { result } = renderTracker(createTestQueryClient());

    await act(async () => {
      result.current({ auth_method: 'credentials', flow: 'native' });
      await vi.runAllTimersAsync();
    });

    expect(analytics.track).toHaveBeenCalledWith(
      'Login Succeeded',
      { auth_method: 'credentials', flow: 'native', is_new_account: false, account_age_hours: 9600 },
      { timestamp: SIGNED_IN_AT },
    );
  });

  it('still fires, without the account-age props, when the profile read fails', async () => {
    graphql.request.mockRejectedValue(new Error('offline'));
    const { result } = renderTracker(createTestQueryClient());

    await act(async () => {
      result.current({ auth_method: 'apple', flow: 'native' });
      await vi.runAllTimersAsync();
    });

    expect(analytics.track).toHaveBeenCalledWith(
      'Login Succeeded',
      { auth_method: 'apple', flow: 'native' },
      { timestamp: SIGNED_IN_AT },
    );
  });

  it(`gives up on a hung profile read after ${PROFILE_READ_TIMEOUT_MS} ms and fires without the props`, async () => {
    graphql.request.mockReturnValue(new Promise(() => {}));
    const { result } = renderTracker(createTestQueryClient());

    await act(async () => {
      result.current({ auth_method: 'google', flow: 'web_fallback' });
      await vi.advanceTimersByTimeAsync(PROFILE_READ_TIMEOUT_MS - 1);
    });
    expect(analytics.track).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(analytics.track).toHaveBeenCalledWith(
      'Login Succeeded',
      { auth_method: 'google', flow: 'web_fallback' },
      { timestamp: SIGNED_IN_AT },
    );
  });
});
