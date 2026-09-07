import type { AnalyticsEventProperties } from './create-analytics';

// `null` means unresolved/unknown; mapped to `undefined` below so sanitizeForPosthog drops it.
export type CohortProfileInput = {
  isTester: boolean | null;
  // Written here rather than riding identify(): reconcileAnalyticsIdentity skips
  // identify() on a cold start that is already anchored to this user, so an email
  // changed after first login would otherwise never reach PostHog. This effect
  // re-fires when the value actually changes, so it costs no extra events.
  email: string | null;
  createdAt: string | null;
  primaryBoard: string | null;
  favoriteCount: number | null;
  integrationsConnectedCount: number | null;
};

export type CohortPersonProperties = {
  set: AnalyticsEventProperties;
  setOnce: AnalyticsEventProperties;
};

// setOnce here is an immutable fact (account-created date) that must survive later runs unchanged.
export function buildCohortPersonProperties(input: CohortProfileInput): CohortPersonProperties {
  return {
    set: {
      role: input.isTester === null ? undefined : input.isTester ? 'tester' : 'user',
      email: input.email ?? undefined,
      primary_board: input.primaryBoard ?? undefined,
      favorite_count: input.favoriteCount ?? undefined,
      integrations_connected_count: input.integrationsConnectedCount ?? undefined,
    },
    setOnce: {
      first_seen_at: input.createdAt ?? undefined,
    },
  };
}
