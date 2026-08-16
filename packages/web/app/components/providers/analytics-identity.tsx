'use client';

import { useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { usePathname } from 'next/navigation';
import * as Sentry from '@sentry/nextjs';
import { getAnalyticsAnonymousId, getAnalyticsDistinctId, identify, reset } from '@/app/lib/analytics';
import { isAdminAnalyticsUrl, isEmbedAnalyticsUrl } from '@/app/lib/analytics-paths';

// A throw here would take down the root layout (see the try/catch below), so
// the failure is swallowed — but swallowing it silently would hide a broken
// analytics identity for as long as it takes someone to notice a flat person
// count. Report the first one per page load and stay quiet after that.
let hasReportedIdentityFailure = false;

/**
 * Tells PostHog which person the current browser belongs to.
 *
 * Between the W-16 chrome teardown (#4467) and #4511 nothing on www called
 * `identify()` at all: `PartyProfileProvider` owned the identity effect and was
 * deleted with the climbing UI, so no PostHog person existed for
 * `session.user.id`. That is invisible until something reads a person — a
 * server-side flag keyed on a person property (the `/gyms` directory gate),
 * person-level segmentation, an anonymous → authenticated funnel — at which
 * point it silently resolves to nothing while every dashboard looks healthy.
 *
 * Mounted directly under `SessionProviderWrapper` in `app/layout.tsx`: it needs
 * `useSession()` and nothing else, it must run on every route (a person can be
 * created on any page, not just the ones under `SiteChrome`), and it renders
 * nothing. `AnalyticsClient` — the other analytics side-effect component — sits
 * OUTSIDE the session provider and would throw if it called `useSession()`,
 * which is why this is a separate component rather than a few more lines there.
 *
 * ## Why this is not `reconcileAnalyticsIdentity`
 *
 * Mobile drives the shared reconciler from `@boardsesh/analytics`, and both
 * platforms still agree on the person — both identify with `users.id`, the same
 * value `getPosthogDistinctId()` hands the server-side flag read. What differs
 * is the substrate underneath. Mobile's anonymous identity is a party-profile
 * UUID it owns and can hand to `alias()`; web's is the SDK's own anonymous id,
 * and web therefore needs two behaviours the shared routine cannot express:
 *
 *  - **No `alias()`.** `identify()` already merges the anonymous person into
 *    the authenticated one by sending `$anon_distinct_id`, and PostHog refuses
 *    that merge when the source is already identified. `$create_alias` has no
 *    such protection: firing it while the client is pinned to another user's id
 *    merges two real people, irreversibly. Dropping the call removes the whole
 *    failure class instead of guarding it.
 *  - **Signed out means `reset()` and nothing else.** The shared routine
 *    follows its reset with `identify(anonId)`, which flips the SDK back to
 *    `PersonMode: 'identified'`, creates a junk identified person per sign-out,
 *    and stamps `$is_identified: true` on every later anonymous event. Letting
 *    the SDK mint its own anonymous id after a reset keeps
 *    `distinctId === anonymousId` a truthful test for "anonymous".
 */
export default function AnalyticsIdentity() {
  const { data: session, status } = useSession();
  const pathname = usePathname();

  const authUserId = session?.user?.id ?? null;
  const authEmail = session?.user?.email ?? null;

  useEffect(() => {
    // Reconciling against a half-resolved session would identify the wrong
    // person; `status === 'loading'` is every page load's first render.
    if (status === 'loading') return;
    // Admin pages are excluded from analytics wholesale, and /embed/** must
    // capture nothing at all — those are iframe widgets on gym websites whose
    // visitors never saw a consent surface (see analytics-paths.ts). Identity
    // events are as much of a capture as a pageview. `pathname` is in the deps,
    // so navigating off either surface reconciles then.
    if (pathname && (isAdminAnalyticsUrl(pathname) || isEmbedAnalyticsUrl(pathname))) return;

    try {
      // `null` means no PostHog client (server render, dev, preview, missing
      // key) or an SDK that has not finished initialising. Either way there is
      // no identity to reconcile.
      const distinctId = getAnalyticsDistinctId();
      const anonymousId = getAnalyticsAnonymousId();
      if (distinctId === null || anonymousId === null) return;

      // The one question that matters, answered out of the SDK's own storage so
      // it is true for browsers that were identified long before this component
      // existed — which on deploy day is nearly all of them, since
      // PartyProfileProvider identified with this same user id until #4467.
      const isPinnedToAPerson = distinctId !== anonymousId;

      if (status !== 'authenticated' || !authUserId) {
        // Signed out while still pinned: drop the identity so the next visitor
        // on this browser starts from a fresh anonymous id. Without this, their
        // anonymous events are attributed to the previous person.
        if (isPinnedToAPerson) reset();
        return;
      }

      // Pinned to somebody else — a shared browser, or a session that switched
      // accounts without a signed-out render in between. Clear first: PostHog
      // must never be asked to stitch one real person onto another.
      if (isPinnedToAPerson && distinctId !== authUserId) reset();

      // Unconditional for a signed-in visitor, including one already identified
      // as this user. @posthog/core turns the repeat into a `$set` and dedupes
      // it against an in-memory hash for the rest of the page load, so the cost
      // is one event per hard load — the cadence PartyProfileProvider had — and
      // in exchange the `email` person property is guaranteed to exist, which is
      // what server-side person-property flag evaluation reads.
      identify(authUserId, authEmail ? { email: authEmail } : undefined);
    } catch (error) {
      // getDistinctId() does a bare JSON.parse of the localStorage blob and
      // storage writes can hit quota, so this effect can throw on corrupt or
      // full storage. It runs in the root layout with no error boundary above
      // it, where a throw would blank the entire app over analytics bookkeeping.
      if (!hasReportedIdentityFailure) {
        hasReportedIdentityFailure = true;
        Sentry.captureException(error);
      }
    }
  }, [status, authUserId, authEmail, pathname]);

  return null;
}
