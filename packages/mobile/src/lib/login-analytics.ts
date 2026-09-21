import { useCallback } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { SHARED_EVENTS, type AnalyticsEventProperties } from '@boardsesh/analytics';
import { accountAgeHours, accountAgeMs } from './account-age';
import { track } from './analytics';
import { getHttpClient } from './graphql/client';
import { GET_PROFILE, type GetProfileQueryResponse } from './graphql/operations';

// `is_new_account` on Login Succeeded (#5654).
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
// backdated to the moment sign-in succeeded. If the profile can't be read in
// PROFILE_READ_TIMEOUT_MS, the event still fires, with both props null.
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

/**
 * The signed-in account's creation time, or null when the profile can't be
 * read in time. Shares the `['profile']` query, so it joins the fetch
 * PartyProfileProvider starts on sign-in rather than making its own.
 *
 * Only a cached profile that names its creation time and is under
 * PROFILE_REUSE_MS old is taken as is. The cache is cleared at every sign-out
 * but not at sign-in, and screens that read the profile while signed out cache
 * `{ profile: null }` under the same key (the backend answers null without a
 * token), so an empty entry is read again. The age bound keeps a reused entry
 * to one read made around this sign-in.
 */
export async function readAccountCreatedAt(
  queryClient: QueryClient,
  timeoutMs: number = PROFILE_READ_TIMEOUT_MS,
): Promise<string | null> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), timeoutMs);
  });
  const profileRead = queryClient
    .fetchQuery({
      queryKey: ['profile'],
      queryFn: () => getHttpClient().request<GetProfileQueryResponse>(GET_PROFILE),
      staleTime: (query) => (query.state.data?.profile?.createdAt ? PROFILE_REUSE_MS : 0),
    })
    .then((response) => response.profile?.createdAt ?? null)
    .catch(() => null);
  try {
    return await Promise.race([profileRead, timedOut]);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Returns the one way sign-in surfaces fire Login Succeeded. Call it the moment
 * sign-in succeeds; it never delays the caller.
 */
export function useTrackLoginSucceeded(): (properties: LoginSucceededProperties) => void {
  const queryClient = useQueryClient();
  return useCallback(
    (properties: LoginSucceededProperties) => {
      const signedInAt = new Date();
      void readAccountCreatedAt(queryClient).then((createdAt) => {
        track(
          SHARED_EVENTS.LoginSucceeded,
          { ...properties, ...accountAgeProperties(createdAt, signedInAt.getTime()) },
          { timestamp: signedInAt },
        );
      });
    },
    [queryClient],
  );
}
