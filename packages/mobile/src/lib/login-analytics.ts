import { useCallback } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { SHARED_EVENTS, type AnalyticsEventProperties } from '@boardsesh/analytics';
import { accountAgeHours, accountAgeMs } from './account-age';
import { track } from './analytics';
import { createConsentBoundAnalyticsRunner } from './consent-bound-analytics';
import { getHttpClient } from './graphql/client';
import { GET_PROFILE, type GetProfileQueryResponse } from './graphql/operations';

// `is_new_account` on Login Succeeded (#5654, #6027).
//
// The native token responses (`/auth/native/credentials`, `/oauth`,
// `/exchange`, `/register`) carry only the JWT pair, so at the moment sign-in
// succeeds the app does not know when the account was made. Apple and Google
// sign-in find OR create the account, so the auth method alone can't tell a
// newcomer from a returning climber either. The profile query is the first
// place the client learns `createdAt`, and the app fetches it right after
// sign-in anyway (PartyProfileProvider), so Login Succeeded reads it through
// the same `['profile']` cache entry and waits for it.
//
// Waiting would put Login Succeeded after the first screen views of the signed
// in app, which breaks every funnel that starts at it. So the event is
// backdated to the moment sign-in succeeded, and it never waits longer than
// PROFILE_READ_TIMEOUT_MS: past that it fires with both age props null.
//
// That null used to be the end of it, and on store version 2.5.0 it was the
// answer for 42% of logins (week of 2026-09-28: true 203, null 176, false 29),
// which made sign-ups uncountable in PostHog. Two things changed (#6027):
//
// 1. The wait no longer rests on one read. It watches the `['profile']` cache
//    entry, so a creation time fetched by ANY reader settles it, and it reads
//    again itself when a read comes back empty or fails.
// 2. When the 5 s pass without an answer, the watch keeps going for
//    LATE_RESOLVE_WINDOW_MS. If the creation time arrives in that window, a
//    second event, Login Account Age Resolved, carries the two age props and
//    the same sign-in props, backdated to the same instant. Nobody lengthened
//    the timeout: Login Succeeded still fires on time for the funnels.
//
// So a sign-up is a person with `is_new_account = true` on EITHER event. The
// query is in docs/growth-metrics.md ("Counting sign-ups").
//
// `account_age_read` on Login Succeeded says how the 5 s went: 'ok', 'timeout'
// (no read had answered), 'empty' (the last read answered with no profile) or
// 'error' (the last read failed). It is there because the cause of the 42% was
// not established from the data, and the split is what will name it.
//
// Backdating moves the timestamp only. PostHog reads super and session
// properties when the event is captured, after the wait, so `$screen_name` is
// usually the first signed-in screen, not the auth screen, and super
// properties registered after sign-in can ride along. That is why every call
// names its screen in the `screen` prop: explicit props win over session ones.

/** At most this old at sign-in and the account counts as new: this sign-in made it, or it was made earlier that day. */
export const NEW_ACCOUNT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** How long Login Succeeded waits for the profile before firing with the account-age props null. */
export const PROFILE_READ_TIMEOUT_MS = 5_000;

/** A cached profile that names its creation time is reused, not fetched again, while it is younger than this. */
export const PROFILE_REUSE_MS = 60_000;

/**
 * How long after sign-in a late creation time still earns a Login Account Age
 * Resolved event. Past it the watch lets go: an answer that late is more likely
 * to belong to a different session than to be worth the open subscription.
 */
export const LATE_RESOLVE_WINDOW_MS = 2 * 60_000;

/**
 * Waits between this module's own profile reads when one comes back without a
 * creation time. Short at first, in case the miss was a race with the session
 * coming up; spread out after, so a backend that is down is not hammered. The
 * list ends inside LATE_RESOLVE_WINDOW_MS, and the reads stop with it.
 */
export const PROFILE_REREAD_DELAYS_MS: readonly number[] = [1_000, 3_000, 10_000, 30_000, 60_000];

/** How the wait for the creation time went, as far as Login Succeeded could see. */
export type AccountAgeRead = 'ok' | 'timeout' | 'empty' | 'error';

export type AccountAgeProperties = { is_new_account: boolean | null; account_age_hours: number | null };

/**
 * Account age at sign-in, as event props. Both are null when the creation time
 * is unknown or unreadable, so the event carries no guess. `is_new_account`
 * compares milliseconds, so the 24 h line is exact; `account_age_hours` is the
 * shared whole-hours definition (./account-age).
 */
export function accountAgeProperties(createdAt: string | null | undefined, signedInAtMs: number): AccountAgeProperties {
  const ageMs = accountAgeMs(createdAt, signedInAtMs);
  return {
    is_new_account: ageMs === null ? null : ageMs <= NEW_ACCOUNT_MAX_AGE_MS,
    account_age_hours: accountAgeHours(createdAt, signedInAtMs),
  };
}

/** Login Succeeded's props from the caller: the screen it fired on is required. */
export type LoginSucceededProperties = AnalyticsEventProperties & { screen: 'login' | 'register' };

const PROFILE_QUERY_KEY = ['profile'] as const;

function isProfileQueryKey(queryKey: readonly unknown[]): boolean {
  return queryKey.length === 1 && queryKey[0] === 'profile';
}

/** One read of the profile through the shared cache entry. Never rejects. */
async function readProfileOnce(queryClient: QueryClient): Promise<Exclude<AccountAgeRead, 'timeout'>> {
  try {
    const response = await queryClient.fetchQuery({
      queryKey: PROFILE_QUERY_KEY,
      queryFn: () => getHttpClient().request<GetProfileQueryResponse>(GET_PROFILE),
      // Only a cached profile that names its creation time and is under
      // PROFILE_REUSE_MS old is taken as is. The cache is cleared at every
      // sign-out but not at sign-in, and screens that read the profile while
      // signed out cache `{ profile: null }` under the same key (the backend
      // answers null without a token), so an empty entry is read again.
      staleTime: (query) => (query.state.data?.profile?.createdAt ? PROFILE_REUSE_MS : 0),
    });
    return response.profile?.createdAt ? 'ok' : 'empty';
  } catch {
    return 'error';
  }
}

export type AccountCreatedAtWatch = {
  /**
   * Settles within `quickMs`: the creation time, or null with the reason it is
   * not known yet.
   */
  quick: Promise<{ createdAt: string | null; read: AccountAgeRead }>;
  /**
   * Settles when the creation time arrives, or with null when the watch ends
   * without one: `lateMs` passed, or the cache entry was removed (sign-out
   * clears the cache, and the next profile in it is somebody else's).
   */
  settled: Promise<string | null>;
};

/**
 * Watches for the signed-in account's creation time.
 *
 * It listens to the `['profile']` cache entry instead of trusting one read, so
 * it is settled by whichever reader gets there first: PartyProfileProvider's
 * fetch on sign-in, a screen that mounts later, or this module's own reads. A
 * read that fails, or that joined a fetch started before the tokens landed and
 * so came back as `{ profile: null }`, is no longer the final word.
 */
export function watchAccountCreatedAt(
  queryClient: QueryClient,
  { quickMs = PROFILE_READ_TIMEOUT_MS, lateMs = LATE_RESOLVE_WINDOW_MS }: { quickMs?: number; lateMs?: number } = {},
): AccountCreatedAtWatch {
  let finished = false;
  let lastRead: Exclude<AccountAgeRead, 'timeout'> | null = null;
  let settle: (createdAt: string | null) => void = () => {};
  const settled = new Promise<string | null>((resolve) => {
    settle = resolve;
  });
  let wakeReread: () => void = () => {};
  let rereadTimeoutId: ReturnType<typeof setTimeout> | undefined;

  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (!isProfileQueryKey(event.query.queryKey)) return;
    if (event.type === 'removed') {
      finish(null);
      return;
    }
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    const cachedProfile: GetProfileQueryResponse | undefined = event.query.state.data;
    const createdAt = cachedProfile?.profile?.createdAt;
    if (createdAt) finish(createdAt);
  });
  const lateTimeoutId = setTimeout(() => finish(null), lateMs);

  function finish(createdAt: string | null): void {
    if (finished) return;
    finished = true;
    unsubscribe();
    clearTimeout(lateTimeoutId);
    clearTimeout(rereadTimeoutId);
    wakeReread();
    settle(createdAt);
  }

  // This module's own reads. A read that answers with a creation time settles
  // the watch through the cache subscription above, like anyone else's would.
  void (async () => {
    for (const rereadDelayMs of [0, ...PROFILE_REREAD_DELAYS_MS]) {
      if (rereadDelayMs > 0) {
        // `finish` calls whichever `wakeReread` is current, and it is assigned
        // here before the timer is armed, so a finish during the wait always
        // ends this wait and never an earlier one.
        await new Promise<void>((resolve) => {
          wakeReread = resolve;
          rereadTimeoutId = setTimeout(resolve, rereadDelayMs);
        });
      }
      if (finished) return;
      lastRead = await readProfileOnce(queryClient);
      if (finished) return;
      // A fresh cached profile is reused without a fetch, so no cache event
      // fires for it: take the answer straight from the entry.
      if (lastRead === 'ok') {
        finish(queryClient.getQueryData<GetProfileQueryResponse>(PROFILE_QUERY_KEY)?.profile?.createdAt ?? null);
        return;
      }
    }
  })();

  let quickTimeoutId: ReturnType<typeof setTimeout> | undefined;
  const quickDeadline = new Promise<null>((resolve) => {
    quickTimeoutId = setTimeout(() => resolve(null), quickMs);
  });
  const quick = Promise.race([settled, quickDeadline]).then((createdAt) => {
    clearTimeout(quickTimeoutId);
    if (createdAt) return { createdAt, read: 'ok' as const };
    return { createdAt: null, read: lastRead === null || lastRead === 'ok' ? ('timeout' as const) : lastRead };
  });

  return { quick, settled };
}

/**
 * Fires Login Succeeded for a sign-in that just succeeded, and Login Account
 * Age Resolved after it when the account's age only became known later. Never
 * delays the caller.
 */
export function trackLoginSucceeded(queryClient: QueryClient, properties: LoginSucceededProperties): void {
  const signedInAt = new Date();
  const captureWhenReady = createConsentBoundAnalyticsRunner();
  const watch = watchAccountCreatedAt(queryClient);
  void watch.quick.then(({ createdAt, read }) => {
    captureWhenReady(() =>
      track(
        SHARED_EVENTS.LoginSucceeded,
        { ...properties, ...accountAgeProperties(createdAt, signedInAt.getTime()), account_age_read: read },
        { timestamp: signedInAt },
      ),
    );
    if (createdAt) return;
    void watch.settled.then((lateCreatedAt) => {
      if (!lateCreatedAt) return;
      captureWhenReady(() =>
        track(
          SHARED_EVENTS.LoginAccountAgeResolved,
          {
            ...properties,
            ...accountAgeProperties(lateCreatedAt, signedInAt.getTime()),
            resolved_after_ms: Date.now() - signedInAt.getTime(),
          },
          { timestamp: signedInAt },
        ),
      );
    });
  });
}

/**
 * Returns the one way sign-in surfaces fire Login Succeeded. Call it the moment
 * sign-in succeeds; it never delays the caller.
 */
export function useTrackLoginSucceeded(): (properties: LoginSucceededProperties) => void {
  const queryClient = useQueryClient();
  return useCallback(
    (properties: LoginSucceededProperties) => trackLoginSucceeded(queryClient, properties),
    [queryClient],
  );
}
