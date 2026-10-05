import type { AnalyticsProperties } from './client';

// The identity state machine for the mobile app (party-profile-provider.tsx).
//
// The rule: `identify()` is the only call that links an anonymous person to an
// account. Never send `alias()` / `$create_alias` from here.
//
// `identify(userId)` already carries the anonymous id as `$anon_distinct_id`,
// and PostHog merges that anonymous person into the account's person. This
// routine used to send `alias(userId)` first. When the account already had a
// PostHog person (a returning climber on a fresh install), the two never
// merged: the anonymous person kept the login and its first screen and read as
// a brand-new climber who left after one screen. Measured 2026-09-08 to
// 2026-10-01, 18.6% of Android and 6.3% of iOS sign-ins split that way. See
// "Identity-split pitfall" in docs/growth-metrics.md.
//
// Web dropped `alias()` first, for a second reason: `$create_alias` has no
// guard against merging two real people. Its identity effect is not this
// routine. Read the header of
// packages/web/app/components/providers/analytics-identity.tsx before changing
// either one.

// The subset of the analytics client the reconciler drives. Returns are `unknown`
// so platforms can inject either the void SDK methods or the boolean-returning
// wrapper functions. There is no `alias` here on purpose (see the rule above).
export type IdentityClient = {
  identify(distinctId: string, properties?: AnalyticsProperties): unknown;
  reset(): unknown;
  // The distinct_id the SDK has persisted across launches, when the platform can
  // supply it. Optional so a caller that cannot read it keeps the old behaviour.
  getDistinctId?(): string | null | undefined;
};

export type ReconcileAnalyticsIdentityInput = {
  // Anonymous device identity (party-profile UUID) — the canonical anon distinct_id.
  profileId: string;
  // Authenticated user id, when known. Null when signed out or not yet fetched.
  authUserId: string | null;
  authEmail?: string | null;
  isAuthenticated: boolean;
  // The distinct_id the client currently believes it is (caller persists this in
  // a ref across renders). Null on first run.
  lastDistinctId: string | null;
  client: IdentityClient;
};

// Drives the anonymous → authenticated PostHog identity transition so a
// climber's pre-login events merge into their account's person. Returns the next
// distinct_id for the caller to persist.
//
// Authenticated branch: reset() if switching off a foreign id → identify(anon)
// unless already anchored there → identify(user, {email}).
// Signed-out branch: reset() if needed → identify(anon).
export function reconcileAnalyticsIdentity(input: ReconcileAnalyticsIdentityInput): string | null {
  const { profileId, authUserId, authEmail, isAuthenticated, lastDistinctId, client } = input;

  if (isAuthenticated && authUserId) {
    // Already switched to this user — nothing to do (avoids re-firing identify on
    // every navigation/state tick).
    if (lastDistinctId === authUserId) return lastDistinctId;

    // Cold start on a device that is already identified as this user.
    // `lastDistinctId` lives in a ref that is null at every mount, but the SDK
    // persists its distinct_id, so without this guard every launch re-anchors a
    // known user onto the anonymous UUID and immediately switches back: two
    // `$identify` per launch, and `$anon_distinct_id` on the first one is the
    // PREVIOUS user's id. The device was linked to this account on the launch
    // that signed in, so the round-trip has nothing left to accomplish.
    //
    // The trade: `identify(authUserId, {email})` is skipped too, so an email
    // changed after the first login is not re-sent until the next identity
    // switch. Person traits that do change are written by the cohort
    // person-properties effect instead.
    if (lastDistinctId === null && authUserId === client.getDistinctId?.()) {
      return authUserId;
    }

    // Coming from a different authed user — clear that identity before re-anchoring.
    if (lastDistinctId && lastDistinctId !== profileId) {
      client.reset();
    }
    // Anchor on the anonymous id first, so the identify below carries it as
    // `$anon_distinct_id` and PostHog merges anon → user.
    if (lastDistinctId !== profileId) {
      client.identify(profileId);
    }
    client.identify(authUserId, authEmail ? { email: authEmail } : undefined);
    return authUserId;
  }

  if (!isAuthenticated) {
    if (lastDistinctId === profileId) return lastDistinctId;
    if (lastDistinctId && lastDistinctId !== profileId) {
      client.reset();
    }
    client.identify(profileId);
    return profileId;
  }

  // Authenticated but the user id hasn't resolved yet — hold the current identity
  // until authUserId arrives (the effect re-runs when it does).
  return lastDistinctId;
}
