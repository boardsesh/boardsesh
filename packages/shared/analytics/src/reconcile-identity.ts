import type { AnalyticsProperties } from './client';

// Synchronous record of which (anonymous → authenticated) alias pairs have
// already been sent, so a re-login or reload doesn't fire duplicate
// `$create_alias` events. Sync (not Promise-returning) so the reconcile routine
// stays a pure function usable directly inside a React effect. Web backs this
// with localStorage; mobile with an in-memory Set hydrated from AsyncStorage.
export type AliasDedupeStore = {
  hasRecordedAlias(profileId: string, userId: string): boolean;
  recordAlias(profileId: string, userId: string): void;
};

// The subset of the analytics client the reconciler drives. Returns are `unknown`
// so platforms can inject either the void SDK methods or the boolean-returning
// wrapper functions. `alias` is inspected: a literal `false` means "no client,
// nothing sent" (the web wrapper's contract) and suppresses recording the dedupe
// pair, preserving web's "only record on success" behaviour.
export type IdentityClient = {
  identify(distinctId: string, properties?: AnalyticsProperties): unknown;
  reset(): unknown;
  alias(newId: string): unknown;
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
  aliasStore: AliasDedupeStore;
};

// Pure port of the web identity effect (party-profile-context.tsx). Drives the
// anonymous → authenticated PostHog identity transition so historical anonymous
// events merge into the authed user (the lever for cross-session/-device
// retention cohorts). Returns the next distinct_id for the caller to persist.
//
// Authenticated branch: reset() if switching off a foreign id → identify(anon)
// → alias(user) once (deduped) → identify(user, {email}).
// Signed-out branch: reset() if needed → identify(anon).
export function reconcileAnalyticsIdentity(input: ReconcileAnalyticsIdentityInput): string | null {
  const { profileId, authUserId, authEmail, isAuthenticated, lastDistinctId, client, aliasStore } = input;

  if (isAuthenticated && authUserId) {
    // Already switched to this user — nothing to do (avoids re-firing identify on
    // every navigation/state tick).
    if (lastDistinctId === authUserId) return lastDistinctId;

    // Cold start on a device that is already identified as this user.
    // `lastDistinctId` lives in a ref that is null at every mount, but the SDK
    // persists its distinct_id, so without this guard every launch re-anchors a
    // known user onto the anonymous UUID and immediately switches back: two
    // `$identify` per launch, and `$anon_distinct_id` on the first one is the
    // PREVIOUS user's id. The alias is already recorded (the store is persisted),
    // so the round-trip has nothing left to accomplish.
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
    // Anchor on the anonymous id first so the alias links anon → user.
    if (lastDistinctId !== profileId) {
      client.identify(profileId);
    }
    if (profileId !== authUserId && !aliasStore.hasRecordedAlias(profileId, authUserId)) {
      const aliased = client.alias(authUserId);
      if (aliased !== false) {
        aliasStore.recordAlias(profileId, authUserId);
      }
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
