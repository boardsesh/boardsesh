import type { AnalyticsProperties } from './client';

// The identity state machine for the mobile app (party-profile-provider.tsx).
//
// Three rules. Web follows the same three in
// packages/web/app/components/providers/analytics-identity.tsx; read that
// header before changing either routine.
//
// 1. `identify()` is the only call that links an anonymous person to an
//    account. Never send `alias()` / `$create_alias` from here: it has no guard
//    against merging two real people.
// 2. Signed out means the SDK's own anonymous id, never an `identify()`. An
//    `identify(someAnonymousId)` is a real `$identify` whenever the SDK is not
//    already on that id. PostHog then marks the anonymous person identified and
//    refuses to merge it into an account that already has a person.
// 3. `reset()` only when the SDK is pinned to a person. A reset on an SDK that
//    is already anonymous throws its anonymous id away, so the pre-login events
//    and the sign-in end up on different ids.
//
// What this replaced: until 2026-10 the routine identified the party-profile
// UUID while signed out. A control run on three pristine installs showed
// `$identify(distinct_id = party UUID, $anon_distinct_id = SDK-minted id)` on
// every signed-out cold start, and PostHog created the party person with
// `is_identified = 1`. The party UUID is no longer an analytics id at all. See
// "Identity-split pitfall" in docs/growth-metrics.md for the evidence and for
// what is still unproven.
//
// The routine keeps no state of its own. It reads who the SDK thinks it is on
// every run, so it is right on a cold start, after a reset someone else made,
// and on an install whose persisted state predates these rules.

// The subset of the analytics client the reconciler drives. Returns are `unknown`
// so platforms can inject either the void SDK methods or the boolean-returning
// wrapper functions. There is no `alias` here on purpose (rule 1).
export type IdentityClient = {
  identify(distinctId: string, properties?: AnalyticsProperties): unknown;
  reset(): unknown;
  // The id events are sent under right now. The SDK persists it across launches.
  // Empty or null means the SDK cannot say yet (no client, or storage not
  // loaded), and the reconciler then holds.
  getDistinctId(): string | null | undefined;
  // The SDK's anonymous id. It equals the distinct id exactly when the SDK is
  // anonymous: `identify()` moves the distinct id and leaves this one behind.
  getAnonymousId(): string | null | undefined;
};

export type ReconcileAnalyticsIdentityInput = {
  // Authenticated user id, when known. Null when signed out or not yet fetched.
  authUserId: string | null;
  authEmail?: string | null;
  isAuthenticated: boolean;
  client: IdentityClient;
};

// What the routine did, for tests and for callers that want to log it.
//  - `hold`: not enough is known yet. Run again when the SDK is ready or the
//    user id arrives.
//  - `none`: the SDK already holds the right identity.
export type AnalyticsIdentityAction = 'hold' | 'none' | 'reset' | 'identify' | 'reset-and-identify';

// Moves the SDK to the identity the auth state calls for, in as few calls as
// that takes.
//
// Signed out: reset() if the SDK is pinned to a person, otherwise nothing.
// Signed in: nothing if the SDK is already this user. From anonymous, one
// identify(user, {email}), whose `$anon_distinct_id` is the SDK's un-identified
// anonymous id, which is what PostHog merges on. From any other pinned id,
// reset() first so two people are never stitched together.
export function reconcileAnalyticsIdentity(input: ReconcileAnalyticsIdentityInput): AnalyticsIdentityAction {
  const { authUserId, authEmail, isAuthenticated, client } = input;

  const distinctId = client.getDistinctId();
  const anonymousId = client.getAnonymousId();
  if (!distinctId || !anonymousId) return 'hold';

  // True for a signed-in user, and also for an install upgraded from the old
  // routine, whose SDK is pinned to its party UUID while signed out. Both get
  // the same treatment below, which is what clears the upgraded state: once.
  const isPinnedToAPerson = distinctId !== anonymousId;

  if (!isAuthenticated) {
    if (!isPinnedToAPerson) return 'none';
    client.reset();
    return 'reset';
  }

  // Authenticated but the user id hasn't resolved yet. Hold the current
  // identity until it arrives (the caller runs this again when it does).
  if (!authUserId) return 'hold';

  // Already this user: a cold start on a signed-in device, or a later render.
  // The trade: `identify(authUserId, {email})` is skipped too, so an email
  // changed after the first login is not re-sent until the next identity
  // switch. Person traits that do change are written by the cohort
  // person-properties effect instead.
  if (distinctId === authUserId) return 'none';

  const properties = authEmail ? { email: authEmail } : undefined;

  if (isPinnedToAPerson) {
    client.reset();
    client.identify(authUserId, properties);
    return 'reset-and-identify';
  }

  client.identify(authUserId, properties);
  return 'identify';
}
