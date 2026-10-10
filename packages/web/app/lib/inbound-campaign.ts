// The campaign a visitor arrived with: the `utm_*` params and the Google Ads
// click id on the URL they landed on (#6027).
//
// www runs posthog-js-lite, which sends `$referrer` and `$current_url` but never
// parses campaign params (the full posthog-js does). Over the 28 days to
// 2026-10-05 that left 6,661 www sessions with 0 `$entry_utm_source`, although
// tagged links did arrive (ChatGPT, an Instagram bio). This module is the
// parser; `analytics.ts` puts the result on events and `store-links.ts` carries
// it into the store URL so a tagged visit keeps its source through the install.
//
// Pure and dependency-free on purpose: `store-links.ts` and the hook import it
// without pulling the PostHog client or Sentry into their bundle.

/** The params read off the landing URL, in the order they are reported. */
export const INBOUND_CAMPAIGN_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'gclid',
] as const;

export type InboundCampaignParam = (typeof INBOUND_CAMPAIGN_PARAMS)[number];

/**
 * Only the params the landing URL actually carried. A key is absent, never an
 * empty string, so spreading this into event properties adds nothing for an
 * untagged visit.
 */
export type InboundCampaign = Readonly<Partial<Record<InboundCampaignParam, string>>>;

/**
 * Longest value kept per param. A real `gclid` is about 100 characters and a
 * campaign name far shorter; anything past this is a crafted URL, and the value
 * ends up in an event property and in a store link.
 */
export const MAX_INBOUND_CAMPAIGN_VALUE_LENGTH = 200;

/**
 * Parse the campaign params out of a query string (`location.search`, with or
 * without the leading `?`). Returns `null` when the URL carries none of them.
 *
 * Values are trimmed and capped, and a param that is present but blank is
 * dropped. When a param repeats, the first one wins.
 */
export function parseInboundCampaign(search: string): InboundCampaign | null {
  const searchParams = new URLSearchParams(search);
  const campaign: Partial<Record<InboundCampaignParam, string>> = {};
  let hasAnyParam = false;

  for (const param of INBOUND_CAMPAIGN_PARAMS) {
    const paramValue = searchParams.get(param)?.trim().slice(0, MAX_INBOUND_CAMPAIGN_VALUE_LENGTH).trim();
    if (!paramValue) continue;
    campaign[param] = paramValue;
    hasAnyParam = true;
  }

  return hasAnyParam ? campaign : null;
}

// `undefined` = not read yet; `null` = read, and the landing URL was untagged.
let sessionInboundCampaign: InboundCampaign | null | undefined;

/**
 * The campaign this page session landed with, or `null` for an untagged visit
 * and on the server.
 *
 * Read ONCE, from the URL the first caller sees, and held in memory for the
 * life of the document: the tagged URL is the landing page, and a client-side
 * navigation to `/gyms` afterwards must not turn the visit into an untagged
 * one. `AnalyticsClient` snapshots the landing URL on mount independently of
 * consent; event emission still waits for Allow.
 *
 * Memory, not storage: a full page load (a locale switch, a hard reload on a
 * later page) starts over from that page's URL. Persisting it would mean a new
 * client-side store for a value that includes an ad click id, and every store
 * button on www sits on the page the visitor landed on or one client-side hop
 * away.
 *
 * The returned object is the same reference on every call, which is what lets
 * `useInboundCampaign` hand it to `useSyncExternalStore` as a snapshot.
 */
export function getSessionInboundCampaign(): InboundCampaign | null {
  if (typeof window === 'undefined') return null;
  if (sessionInboundCampaign === undefined) {
    sessionInboundCampaign = parseInboundCampaign(window.location.search);
  }
  return sessionInboundCampaign;
}

/** Test-only: the session value outlives every unmount and every `vi.resetModules()`-free test. */
export function __resetSessionInboundCampaignForTests(): void {
  sessionInboundCampaign = undefined;
}
