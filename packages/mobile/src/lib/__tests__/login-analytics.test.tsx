// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { grantAnalyticsForTest } from '../../../test/consent-fixture';
import { invalidateConsentAccount, updateConsentState } from '../consent-state';

beforeEach(() => grantAnalyticsForTest());

const analytics = vi.hoisted(() => ({ track: vi.fn() }));
const graphql = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('../analytics', () => ({ track: analytics.track }));
vi.mock('../graphql/client', () => ({ getHttpClient: () => ({ request: graphql.request }) }));
vi.mock('../graphql/operations', () => ({ GET_PROFILE: 'query GetProfile' }));

const {
  LATE_RESOLVE_WINDOW_MS,
  NEW_ACCOUNT_MAX_AGE_MS,
  PROFILE_READ_TIMEOUT_MS,
  PROFILE_REREAD_DELAYS_MS,
  PROFILE_REUSE_MS,
  accountAgeProperties,
  useTrackLoginSucceeded,
  watchAccountCreatedAt,
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

  it('keeps an account new up to 24 hours and not a minute past, measured in ms', () => {
    expect(accountAgeProperties(isoBeforeSignIn(NEW_ACCOUNT_MAX_AGE_MS), SIGNED_IN_AT.getTime())).toEqual({
      is_new_account: true,
      account_age_hours: 24,
    });
    // Same whole hour, but past the line: the flag reads the milliseconds.
    expect(accountAgeProperties(isoBeforeSignIn(NEW_ACCOUNT_MAX_AGE_MS + 60_000), SIGNED_IN_AT.getTime())).toEqual({
      is_new_account: false,
      account_age_hours: 24,
    });
  });

  it('reports the age in whole hours rounded down', () => {
    expect(accountAgeProperties(isoBeforeSignIn(59 * 60_000), SIGNED_IN_AT.getTime()).account_age_hours).toBe(0);
    expect(accountAgeProperties(isoBeforeSignIn(30 * 24 * HOUR_MS + 0.9 * HOUR_MS), SIGNED_IN_AT.getTime())).toEqual({
      is_new_account: false,
      account_age_hours: 720,
    });
  });

  it('treats a creation time ahead of the phone clock as brand new', () => {
    expect(accountAgeProperties(isoBeforeSignIn(-5 * 60_000), SIGNED_IN_AT.getTime())).toEqual({
      is_new_account: true,
      account_age_hours: 0,
    });
  });

  it('sends both props as null when the creation time is missing or unreadable', () => {
    const unknownAge = { is_new_account: null, account_age_hours: null };
    expect(accountAgeProperties(null, SIGNED_IN_AT.getTime())).toEqual(unknownAge);
    expect(accountAgeProperties(undefined, SIGNED_IN_AT.getTime())).toEqual(unknownAge);
    expect(accountAgeProperties('not a date', SIGNED_IN_AT.getTime())).toEqual(unknownAge);
  });
});

describe('watchAccountCreatedAt', () => {
  beforeEach(() => {
    graphql.request.mockReset();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(SIGNED_IN_AT);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reuses a profile cached in the last minute instead of fetching again', async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(
      ['profile'],
      { profile: { createdAt: '2026-09-20T08:00:00.000Z' } },
      { updatedAt: Date.now() - PROFILE_REUSE_MS + 1_000 },
    );

    await expect(watchAccountCreatedAt(queryClient).quick).resolves.toEqual({
      createdAt: '2026-09-20T08:00:00.000Z',
      read: 'ok',
    });
    expect(graphql.request).not.toHaveBeenCalled();
  });

  it('reads the profile again when the cached one is older than a minute', async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(
      ['profile'],
      { profile: { createdAt: '2026-09-20T08:00:00.000Z' } },
      { updatedAt: Date.now() - PROFILE_REUSE_MS - 1_000 },
    );
    graphql.request.mockResolvedValue({ profile: { createdAt: '2026-09-21T07:59:00.000Z' } });

    await expect(watchAccountCreatedAt(queryClient).quick).resolves.toEqual({
      createdAt: '2026-09-21T07:59:00.000Z',
      read: 'ok',
    });
    expect(graphql.request).toHaveBeenCalledTimes(1);
  });

  it('reads the profile again when the cache holds the signed-out empty profile', async () => {
    const queryClient = createTestQueryClient();
    // A screen that read the profile before sign-in cached the backend's null.
    queryClient.setQueryData(['profile'], { profile: null });
    graphql.request.mockResolvedValue({ profile: { createdAt: '2026-09-21T07:59:00.000Z' } });

    await expect(watchAccountCreatedAt(queryClient).quick).resolves.toEqual({
      createdAt: '2026-09-21T07:59:00.000Z',
      read: 'ok',
    });
    expect(graphql.request).toHaveBeenCalledTimes(1);
  });

  it('joins a profile read already in flight rather than making its own', async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(['profile'], { profile: null });
    let answerProfile: (response: { profile: { createdAt: string } }) => void = () => {};
    graphql.request.mockReturnValue(
      new Promise((resolve) => {
        answerProfile = resolve;
      }),
    );
    // The refetch PartyProfileProvider starts when sign-in flips it on.
    void queryClient.fetchQuery({ queryKey: ['profile'], queryFn: () => graphql.request('query GetProfile') });

    const { quick } = watchAccountCreatedAt(queryClient);
    answerProfile({ profile: { createdAt: '2026-09-21T07:59:00.000Z' } });

    await expect(quick).resolves.toEqual({ createdAt: '2026-09-21T07:59:00.000Z', read: 'ok' });
    expect(graphql.request).toHaveBeenCalledTimes(1);
  });

  it('fetches the profile into the shared cache entry', async () => {
    const queryClient = createTestQueryClient();
    graphql.request.mockResolvedValue({ profile: { createdAt: '2026-09-21T07:59:00.000Z' } });

    await watchAccountCreatedAt(queryClient).quick;
    expect(graphql.request).toHaveBeenCalledWith('query GetProfile');
    expect(queryClient.getQueryData(['profile'])).toEqual({ profile: { createdAt: '2026-09-21T07:59:00.000Z' } });
  });

  it('reads again inside the 5 s when the first read answers with no profile', async () => {
    const queryClient = createTestQueryClient();
    // The read that joined a fetch started before the tokens landed.
    graphql.request
      .mockResolvedValueOnce({ profile: null })
      .mockResolvedValue({ profile: { createdAt: '2026-09-21T07:59:00.000Z' } });

    const { quick } = watchAccountCreatedAt(queryClient);
    await vi.advanceTimersByTimeAsync(PROFILE_REREAD_DELAYS_MS[0]);

    await expect(quick).resolves.toEqual({ createdAt: '2026-09-21T07:59:00.000Z', read: 'ok' });
    expect(graphql.request).toHaveBeenCalledTimes(2);
  });

  it('reads again inside the 5 s when the first read fails', async () => {
    const queryClient = createTestQueryClient();
    graphql.request
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ profile: { createdAt: '2026-09-21T07:59:00.000Z' } });

    const { quick } = watchAccountCreatedAt(queryClient);
    await vi.advanceTimersByTimeAsync(PROFILE_REREAD_DELAYS_MS[0]);

    await expect(quick).resolves.toEqual({ createdAt: '2026-09-21T07:59:00.000Z', read: 'ok' });
  });

  it('is settled by a creation time another reader fetched', async () => {
    const queryClient = createTestQueryClient();
    graphql.request.mockReturnValue(new Promise(() => {}));

    const { quick } = watchAccountCreatedAt(queryClient);
    // Some other reader's answer lands in the shared entry while ours hangs.
    queryClient.setQueryData(['profile'], { profile: { createdAt: '2026-09-21T07:59:00.000Z' } });

    await expect(quick).resolves.toEqual({ createdAt: '2026-09-21T07:59:00.000Z', read: 'ok' });
  });

  it.each([
    ['timeout', () => graphql.request.mockReturnValue(new Promise(() => {}))],
    ['empty', () => graphql.request.mockResolvedValue({ profile: null })],
    ['error', () => graphql.request.mockRejectedValue(new Error('offline'))],
  ] as const)('says %s when the 5 s pass without a creation time', async (read, arrangeProfileRead) => {
    arrangeProfileRead();
    const { quick } = watchAccountCreatedAt(createTestQueryClient());

    await vi.advanceTimersByTimeAsync(PROFILE_READ_TIMEOUT_MS);

    await expect(quick).resolves.toEqual({ createdAt: null, read });
  });

  it('settles late when the creation time arrives after the 5 s', async () => {
    const queryClient = createTestQueryClient();
    graphql.request.mockRejectedValue(new Error('offline'));
    const { quick, settled } = watchAccountCreatedAt(queryClient);
    await vi.advanceTimersByTimeAsync(PROFILE_READ_TIMEOUT_MS);
    await expect(quick).resolves.toEqual({ createdAt: null, read: 'error' });

    graphql.request.mockResolvedValue({ profile: { createdAt: '2026-09-21T07:59:00.000Z' } });
    await vi.advanceTimersByTimeAsync(PROFILE_REREAD_DELAYS_MS[2]);

    await expect(settled).resolves.toBe('2026-09-21T07:59:00.000Z');
  });

  it('gives up, and stops reading, when the late window closes', async () => {
    const queryClient = createTestQueryClient();
    graphql.request.mockResolvedValue({ profile: null });
    const { settled } = watchAccountCreatedAt(queryClient);

    await vi.advanceTimersByTimeAsync(LATE_RESOLVE_WINDOW_MS);
    await expect(settled).resolves.toBeNull();

    const readsAtClose = graphql.request.mock.calls.length;
    expect(readsAtClose).toBe(PROFILE_REREAD_DELAYS_MS.length + 1);
    graphql.request.mockResolvedValue({ profile: { createdAt: '2026-09-21T07:59:00.000Z' } });
    await vi.advanceTimersByTimeAsync(LATE_RESOLVE_WINDOW_MS);
    expect(graphql.request.mock.calls.length).toBe(readsAtClose);
  });

  it('lets go when the cache is cleared, so the next account cannot answer for this one', async () => {
    const queryClient = createTestQueryClient();
    graphql.request.mockResolvedValue({ profile: null });
    const { settled } = watchAccountCreatedAt(queryClient);
    await vi.advanceTimersByTimeAsync(PROFILE_READ_TIMEOUT_MS);

    // Sign-out clears every query; the profile that lands next is somebody else's.
    queryClient.clear();
    queryClient.setQueryData(['profile'], { profile: { createdAt: '2020-01-01T00:00:00.000Z' } });

    await expect(settled).resolves.toBeNull();
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

  it('keeps a fast profile conversion until account consent and SDK identity resolve', async () => {
    invalidateConsentAccount();
    graphql.request.mockResolvedValue({ profile: { createdAt: isoBeforeSignIn(20_000) } });
    const { result } = renderTracker(createTestQueryClient());
    await act(async () => {
      result.current({ auth_method: 'apple', flow: 'native', screen: 'register' });
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(analytics.track).not.toHaveBeenCalled();
    await act(async () => {
      updateConsentState({ authSettled: true, accountResolved: true, accountId: 'new-user' });
    });
    expect(analytics.track).not.toHaveBeenCalled();
    await act(async () => {
      updateConsentState({ sdkReady: true });
    });
    expect(analytics.track).toHaveBeenCalledExactlyOnceWith(
      'Login Succeeded',
      expect.objectContaining({ auth_method: 'apple', is_new_account: true }),
      { timestamp: SIGNED_IN_AT },
    );
  });

  it('adds is_new_account and backdates the event to the moment sign-in succeeded', async () => {
    graphql.request.mockImplementation(async () => {
      // The profile lands after the sign-in moment, as it does for real.
      vi.setSystemTime(SIGNED_IN_AT.getTime() + 800);
      return { profile: { createdAt: isoBeforeSignIn(20_000) } };
    });
    const { result } = renderTracker(createTestQueryClient());

    await act(async () => {
      result.current({ auth_method: 'google', provider: 'google', flow: 'native', screen: 'login' });
      await vi.runAllTimersAsync();
    });

    expect(analytics.track).toHaveBeenCalledTimes(1);
    expect(analytics.track).toHaveBeenCalledWith(
      'Login Succeeded',
      {
        auth_method: 'google',
        provider: 'google',
        flow: 'native',
        screen: 'login',
        is_new_account: true,
        account_age_hours: 0,
        account_age_read: 'ok',
      },
      { timestamp: SIGNED_IN_AT },
    );
  });

  it('marks a returning account as not new', async () => {
    graphql.request.mockResolvedValue({ profile: { createdAt: isoBeforeSignIn(400 * 24 * HOUR_MS) } });
    const { result } = renderTracker(createTestQueryClient());

    await act(async () => {
      result.current({ auth_method: 'credentials', provider: 'email', flow: 'native', screen: 'login' });
      await vi.runAllTimersAsync();
    });

    expect(analytics.track).toHaveBeenCalledTimes(1);
    expect(analytics.track).toHaveBeenCalledWith(
      'Login Succeeded',
      {
        auth_method: 'credentials',
        provider: 'email',
        flow: 'native',
        screen: 'login',
        is_new_account: false,
        account_age_hours: 9600,
        account_age_read: 'ok',
      },
      { timestamp: SIGNED_IN_AT },
    );
  });

  it('fires once, with the account-age props null, when the profile never reads', async () => {
    graphql.request.mockRejectedValue(new Error('offline'));
    const { result } = renderTracker(createTestQueryClient());

    await act(async () => {
      result.current({
        auth_method: 'apple',
        provider: 'apple',
        flow: 'native',
        screen: 'register',
        is_registration: true,
      });
      await vi.runAllTimersAsync();
    });

    expect(analytics.track).toHaveBeenCalledTimes(1);
    expect(analytics.track).toHaveBeenCalledWith(
      'Login Succeeded',
      {
        auth_method: 'apple',
        provider: 'apple',
        flow: 'native',
        screen: 'register',
        is_registration: true,
        is_new_account: null,
        account_age_hours: null,
        account_age_read: 'error',
      },
      { timestamp: SIGNED_IN_AT },
    );
  });

  it(`still fires at ${PROFILE_READ_TIMEOUT_MS} ms on a hung profile read, with the props null`, async () => {
    graphql.request.mockReturnValue(new Promise(() => {}));
    const { result } = renderTracker(createTestQueryClient());

    await act(async () => {
      result.current({ auth_method: 'google', provider: 'google', flow: 'web_fallback', screen: 'login' });
      await vi.advanceTimersByTimeAsync(PROFILE_READ_TIMEOUT_MS - 1);
    });
    expect(analytics.track).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(analytics.track).toHaveBeenCalledWith(
      'Login Succeeded',
      {
        auth_method: 'google',
        provider: 'google',
        flow: 'web_fallback',
        screen: 'login',
        is_new_account: null,
        account_age_hours: null,
        account_age_read: 'timeout',
      },
      { timestamp: SIGNED_IN_AT },
    );
  });

  it('follows a null Login Succeeded with Login Account Age Resolved when the creation time arrives late', async () => {
    const queryClient = createTestQueryClient();
    graphql.request.mockReturnValue(new Promise(() => {}));
    const { result } = renderTracker(queryClient);

    await act(async () => {
      result.current({ auth_method: 'apple', provider: 'apple', flow: 'native', screen: 'login' });
      await vi.advanceTimersByTimeAsync(PROFILE_READ_TIMEOUT_MS);
    });
    expect(analytics.track).toHaveBeenCalledTimes(1);
    expect(analytics.track.mock.calls[0][1]).toMatchObject({ is_new_account: null, account_age_read: 'timeout' });

    // 12 s after sign-in another reader's profile lands in the shared entry.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_000);
      queryClient.setQueryData(['profile'], { profile: { createdAt: isoBeforeSignIn(90_000) } });
      await vi.runAllTimersAsync();
    });

    expect(analytics.track).toHaveBeenCalledTimes(2);
    expect(analytics.track).toHaveBeenLastCalledWith(
      'Login Account Age Resolved',
      {
        auth_method: 'apple',
        provider: 'apple',
        flow: 'native',
        screen: 'login',
        is_new_account: true,
        account_age_hours: 0,
        resolved_after_ms: 12_000,
      },
      // Backdated to the same instant, so the pair counts in the same day.
      { timestamp: SIGNED_IN_AT },
    );
  });

  // The identity rules (packages/shared/analytics/src/reconcile-identity.ts).
  // Both events can be captured before the sign-in's one `$identify`, while the
  // SDK is still on its anonymous id: the 5 s wait and the identify are settled
  // by the same profile read, in either order. That is safe only while they
  // stay plain captures. A `$set` here, or the account's email, would write
  // person properties onto the anonymous person before the merge.
  it('sends both sign-up events as plain captures, with no person properties and no email', async () => {
    const queryClient = createTestQueryClient();
    graphql.request.mockReturnValue(new Promise(() => {}));
    const { result } = renderTracker(queryClient);

    await act(async () => {
      result.current({ auth_method: 'credentials', provider: 'email', flow: 'native', screen: 'register' });
      await vi.advanceTimersByTimeAsync(PROFILE_READ_TIMEOUT_MS);
      // The profile that settles the late event names the account's email.
      queryClient.setQueryData(['profile'], {
        profile: { id: 'user-1', email: 'climber@example.com', createdAt: isoBeforeSignIn(90_000) },
      });
      await vi.runAllTimersAsync();
    });

    expect(analytics.track.mock.calls.map(([eventName]) => eventName)).toEqual([
      'Login Succeeded',
      'Login Account Age Resolved',
    ]);
    for (const [, eventProperties] of analytics.track.mock.calls) {
      expect(eventProperties).not.toHaveProperty('$set');
      expect(eventProperties).not.toHaveProperty('$set_once');
      expect(eventProperties).not.toHaveProperty('email');
      expect(JSON.stringify(eventProperties)).not.toContain('climber@example.com');
    }
  });

  it('sends no follow-up when Login Succeeded already knew the account age', async () => {
    const queryClient = createTestQueryClient();
    graphql.request.mockResolvedValue({ profile: { createdAt: isoBeforeSignIn(20_000) } });
    const { result } = renderTracker(queryClient);

    await act(async () => {
      result.current({ auth_method: 'google', provider: 'google', flow: 'native', screen: 'login' });
      await vi.runAllTimersAsync();
      // A later profile refetch must not read as a second answer.
      queryClient.setQueryData(['profile'], { profile: { createdAt: isoBeforeSignIn(20_000) } });
      await vi.runAllTimersAsync();
    });

    expect(analytics.track).toHaveBeenCalledTimes(1);
  });
});
