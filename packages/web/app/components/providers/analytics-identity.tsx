'use client';

import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { usePathname } from 'next/navigation';
import { v4 as uuidv4 } from 'uuid';
import { reconcileAnalyticsIdentity } from '@boardsesh/analytics';
import { alias, getAnalyticsDistinctId, identify, reset } from '@/app/lib/analytics';
import { isAdminAnalyticsUrl } from '@/app/lib/analytics-paths';
import { analyticsIdentityStore } from '@/app/lib/analytics-identity-store';

/**
 * Tells PostHog which person the current browser belongs to.
 *
 * Between the W-16 chrome teardown (#4467) and #4511 nothing on www called
 * `identify()` at all: `PartyProfileProvider` owned the identity effect and was
 * deleted with the climbing UI, so every web event landed on an anonymous
 * distinct id and no PostHog person existed for `session.user.id`. That is
 * invisible until something reads a person — a server-side flag keyed on a
 * person property (the `/gyms` directory gate), person-level segmentation, or
 * an anonymous → authenticated funnel — at which point it silently resolves to
 * nothing while every dashboard looks healthy.
 *
 * The reset / identify / alias state machine itself is the shared, pure
 * `reconcileAnalyticsIdentity` from `@boardsesh/analytics`, the same one mobile
 * drives from its `PartyProfileProvider`. Both platforms must land on the same
 * person for the same human, so this deliberately does not reimplement it.
 *
 * Mounted directly under `SessionProviderWrapper` in `app/layout.tsx`: it needs
 * `useSession()` and nothing else, it must run on every route (a person can be
 * created on any page, not just the ones under `SiteChrome`), and it renders
 * nothing. `AnalyticsClient` — the other analytics side-effect component — sits
 * OUTSIDE the session provider and would throw if it called `useSession()`,
 * which is why this is a separate component rather than a few more lines there.
 */
export default function AnalyticsIdentity() {
  const { data: session, status } = useSession();
  const pathname = usePathname();
  const [isStoreHydrated, setIsStoreHydrated] = useState(false);

  useEffect(() => {
    let mounted = true;
    void analyticsIdentityStore.hydrate().then(() => {
      if (mounted) setIsStoreHydrated(true);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const authUserId = session?.user?.id ?? null;
  const authEmail = session?.user?.email ?? null;

  useEffect(() => {
    // Nothing is known about who this is until IndexedDB answers, and
    // reconciling against a half-resolved session would identify the wrong
    // person — `status === 'loading'` is every page load's first render.
    if (!isStoreHydrated) return;
    if (status === 'loading') return;
    // Admin pages are excluded from analytics wholesale (isAdminAnalyticsUrl is
    // also the wrapper's shouldSkip). Reconciling here would record transitions
    // the wrapper silently dropped. `pathname` is in the deps, so navigating
    // off /admin reconciles then.
    if (pathname && isAdminAnalyticsUrl(pathname)) return;

    // No PostHog client: server render, dev, preview deploys, missing key.
    // Bail before touching persisted state so nothing records an identity that
    // was never sent, and nothing throws where analytics is off by design.
    const currentDistinctId = getAnalyticsDistinctId();
    if (currentDistinctId === null) return;

    const isAuthenticated = status === 'authenticated';
    // Defensive: on web `status === 'authenticated'` always carries
    // `session.user.id` (see app/lib/auth/types.ts), so this is the shared
    // reconciler's "hold" case, which we skip rather than persist a transition
    // that did not happen.
    if (isAuthenticated && !authUserId) return;

    const identifiedUserId = analyticsIdentityStore.getIdentifiedUserId();

    // The anonymous id to alias FROM.
    //
    // While the client is anonymous that is simply its persisted distinct id —
    // the id every pre-login event on this browser already carries, so aliasing
    // it is what stitches the funnel. A freshly minted UUID would be an id no
    // event was ever sent under and would stitch nothing.
    //
    // While the client is still identified as somebody else (signed out, or
    // switched straight to another account), mint a fresh one instead. Re-using
    // the id already aliased to the previous user would alias one anonymous id
    // to two user ids, and PostHog resolves that by merging the two people —
    // the second user on a shared browser would inherit the first user's
    // identity, which is exactly the failure this has to avoid.
    const isClientIdentityStale = identifiedUserId !== null && identifiedUserId !== authUserId;
    const anonymousId = isClientIdentityStale ? uuidv4() : currentDistinctId;

    const nextDistinctId = reconcileAnalyticsIdentity({
      profileId: anonymousId,
      authUserId,
      authEmail,
      isAuthenticated,
      // What the SDK itself reports, which is the reconciler's contract. When
      // it already matches the authenticated user (a returning signed-in
      // visitor) the whole routine short-circuits and sends nothing.
      lastDistinctId: currentDistinctId,
      client: { identify, alias, reset },
      aliasStore: analyticsIdentityStore.aliasStore,
    });

    analyticsIdentityStore.setIdentifiedUserId(nextDistinctId === authUserId ? authUserId : null);
  }, [isStoreHydrated, status, authUserId, authEmail, pathname]);

  return null;
}
