import { useCallback } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { SHARED_EVENTS, type AnalyticsEventProperties } from '@boardsesh/analytics';
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
// PROFILE_READ_TIMEOUT_MS, the event still fires, without the two props.

/** At most this old at sign-in and the account counts as new: this sign-in made it, or it was made earlier that day. */
export const NEW_ACCOUNT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** How long Login Succeeded waits for the profile before firing without the account-age props. */
export const PROFILE_READ_TIMEOUT_MS = 5_000;

const MS_PER_TENTH_OF_AN_HOUR = 6 * 60 * 1000;

// A cached profile younger than this is reused rather than fetched again.
const PROFILE_REUSE_MS = 60_000;

export type AccountAgeProperties = { is_new_account?: boolean; account_age_hours?: number };

/**
 * Account age at sign-in, as event props. Empty when the creation time is
 * unknown or unreadable, so the event carries no guess.
 */
export function accountAgeProperties(createdAt: string | null | undefined, signedInAtMs: number): AccountAgeProperties {
  if (!createdAt) return {};
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) return {};
  // createdAt is server time. A phone clock running behind can put it in the
  // future, and that account is as new as they come.
  const accountAgeMs = Math.max(0, signedInAtMs - createdAtMs);
  return {
    is_new_account: accountAgeMs <= NEW_ACCOUNT_MAX_AGE_MS,
    account_age_hours: Math.round(accountAgeMs / MS_PER_TENTH_OF_AN_HOUR) / 10,
  };
}

/**
 * The signed-in account's creation time, or null when the profile can't be
 * read in time. Shares the `['profile']` query, so it joins the fetch
 * PartyProfileProvider starts on sign-in rather than making its own. The cache
 * is cleared at every sign-out, so what it finds belongs to this account.
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
      // Anything already cached was fetched after this sign-in, so take it as is.
      staleTime: PROFILE_REUSE_MS,
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
export function useTrackLoginSucceeded(): (properties: AnalyticsEventProperties) => void {
  const queryClient = useQueryClient();
  return useCallback(
    (properties: AnalyticsEventProperties) => {
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
