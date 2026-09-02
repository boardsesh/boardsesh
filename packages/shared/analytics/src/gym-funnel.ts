// The gym funnel event contract (epic #4372 Tier 1, issue #4374).
//
// One climber-facing journey — find a gym, scan the QR on the wall, land on the
// gym page, claim it, then manage it — is measured across half a dozen www
// surfaces that ship in separate PRs. Every one of those PRs imports this module
// instead of typing a string literal, because a single character of drift
// (`"Gym Claim CTA Clicked"` vs `"Gym Claim Cta Clicked"`) silently splits the
// funnel into two PostHog events that nobody notices until the funnel is read.
//
// Why here and not in `events.ts`: `SHARED_EVENTS` is scoped to events fired by
// BOTH web and mobile, and that scoping is what makes it useful. Every event
// below is www-only — the gym directory, claim flow, and manage console have no
// mobile counterpart — so they live in their own module. Keeping them out of
// `events.ts` also keeps this file conflict-free while the sibling gym PRs land.
//
// The contract in one paragraph:
//
//  * Names live in `GYM_FUNNEL_EVENTS`. Never inline the string.
//  * Props are produced by the builders below, which return `{ name, properties }`
//    TOGETHER. A caller physically cannot pair one event's props with another
//    event's name, which is the failure mode a bare name constant still allows.
//  * Property VALUES are identifiers, not copy. They are never translated, never
//    title-cased, never derived from user input. `queryLength` is a number
//    because the search text itself must not leave the browser.
//  * No location precision, ever. `hasGeo` is a boolean and nothing in this
//    module accepts or emits latitude, longitude, or accuracy in any shape.
//  * Every property value is `string | number | boolean`. Web's `track()`
//    (packages/web/app/lib/analytics.ts) types properties as
//    `AllowedPropertyValues = string | number | boolean | null | undefined`, so
//    an array or a nested object is a compile error at the call site — flatten
//    it in the builder instead. See `gymDirectorySearched`, which is why this
//    rule is written down.
//
// Two amendments to #4374's literal wording, both documented at the type they
// affect: `admin_review` (not `admin_sent`), and the three `GymPageCta` members
// that have no call site. Full write-up: docs/gym-funnel-analytics.md.

import type { AnalyticsPropertyValue } from './client';

/**
 * Canonical event names. `as const` so the values are literal types and a typo
 * at a call site is a compile error rather than a new PostHog event.
 */
export const GYM_FUNNEL_EVENTS = {
  ClaimCtaClicked: 'Gym Claim CTA Clicked',
  ClaimSubmitted: 'Gym Claim Submitted',
  ClaimResult: 'Gym Claim Result',
  QrScanned: 'Gym QR Scanned',
  PageCtaClicked: 'Gym Page CTA Clicked',
  DirectorySearched: 'Gym Directory Searched',
  ManageTabViewed: 'Gym Manage Tab Viewed',
} as const;

export type GymFunnelEventKey = keyof typeof GYM_FUNNEL_EVENTS;
export type GymFunnelEventName = (typeof GYM_FUNNEL_EVENTS)[GymFunnelEventKey];

/**
 * Whether the climber was authenticated when the claim CTA was clicked. The
 * split is the point of the event: a signed-out majority means the claim flow is
 * losing people at the auth wall rather than at the claim form.
 */
export type GymClaimViewerState = 'signed-in' | 'signed-out';

/**
 * Where the claim CTA the climber clicked was rendered.
 *
 *  - `gym-page`      — packages/web/app/gym/[gym_slug]/gym-claim-cta.tsx
 *  - `preview-sheet` — packages/web/app/components/gym-entity/gym-detail.tsx
 *                      (the gym preview sheet opened from a board page)
 *  - `directory-card` — a claim affordance on a gym card in the directory
 *                       listing. Reserved by #4374; the directory surface ships
 *                       in a later PR of this epic.
 *  - `similar-gyms`  — packages/web/app/components/gym-entity/similar-gym-suggestions.tsx
 *                      (the duplicate-check list inside the create-gym form).
 *                      NOT in #4374's list; added because the call site is real
 *                      and folding it into `directory-card` would mix "browsing
 *                      the directory" with "about to create a duplicate".
 */
export type GymClaimPlacement = 'gym-page' | 'preview-sheet' | 'directory-card' | 'similar-gyms';

/**
 * Which proof path the claimant submitted. Mirrors the `GymClaimMethod` GraphQL
 * enum (packages/shared-schema/src/schema/gyms.ts): `domain` = verified control
 * of an email on the gym's website domain, `admin` = queued for human review.
 */
export type GymClaimSubmitMethod = 'domain' | 'admin';

/**
 * What the backend did with the claim.
 *
 * AMENDMENT TO #4374: the issue writes this union as
 * `'email_sent' | 'approved' | 'admin_sent' | 'error'`. There is no `admin_sent`
 * anywhere in the system. The GraphQL enum `GymClaimRequestStatus`
 * (packages/shared-schema/src/schema/gyms.ts) declares `email_sent`,
 * `admin_review`, `approved`, and the resolver
 * (packages/backend/src/graphql/resolvers/social/gym-claims.ts) returns
 * `{ status: 'admin_review' }`. Shipping `admin_sent` would mean every call site
 * had to remap a value it already holds, and any site that forgot would emit a
 * status that matches nothing in the backend. We ship the backend's spelling.
 *
 * `error` is ours, not the backend's: the mutation threw or the network failed,
 * so no `GymClaimRequestStatus` exists to report.
 */
export type GymClaimResultStatus = 'email_sent' | 'approved' | 'admin_review' | 'error';

/**
 * Physical medium the scanned QR code was printed on or displayed by.
 *
 * PRODUCER REALITY, and it is not what the member list suggests: only `poster`
 * currently has a producer that can reach a gym page. `Gym QR Scanned` fires
 * from the QR landing tracker, which mounts on `/gym/[gym_slug]` and nowhere
 * else. The kiosk's per-board QR (`components/kiosk/board-slot/board-install-qr.tsx`)
 * encodes `/b/{slug}`, and `app/b/[board_slug]/page.tsx` redirects to
 * `/b/{slug}/{angle}/list`, which renders no tracker. A `kiosk` or `board` scan
 * therefore cannot fire this event today.
 *
 * The params themselves DO survive that hop as of #4379 — the redirect carries
 * them through `gymQrAttributionQuery` (`packages/web/app/lib/gym-attribution.ts`),
 * so a kiosk scan is attributable from a server log. It is the missing tracker
 * at the destination, and only that, which keeps the event unfireable.
 *
 * Both members are kept anyway: the param contract has to parse all three so a
 * future gym-page-targeted kiosk or board QR is a call-site change, not a
 * vocabulary change that breaks the printed codes already on walls.
 */
export const GYM_QR_MEDIUMS = ['poster', 'kiosk', 'board'] as const;
export type GymQrMedium = (typeof GYM_QR_MEDIUMS)[number];

/**
 * Secondary CTAs on the public gym page. Claiming has its own three events, so
 * it is deliberately absent here.
 *
 * AMENDMENT TO #4374 — the issue lists
 * `'install' | 'follow' | 'kiosk' | 'website' | 'directions' | 'report-duplicate' | 'report-listing'`.
 * Three are dropped because shipping a member with no call site creates a value
 * that can never appear in PostHog, which reads as a broken breakdown:
 *
 *  - `install` — installing is NOT a `Gym Page CTA Clicked`. It stays on
 *    `App Install Click`, the event the five existing web call sites (home page,
 *    Capacitor retirement screen) already fire, so the install funnel is one
 *    funnel rather than two that have to be unioned.
 *
 *    The gym-page install CTA (PR9 of this epic) fires
 *    `{ platform, source, placement: 'gym-page', gymSlug }`. `source` keeps its
 *    existing meaning and values (`'google-play'`, `'app-store'`, …)
 *    UNCHANGED — PH-13's install-source breakdown is grouped by it and has to
 *    stay comparable across this change — and `placement` + `gymSlug` are added
 *    alongside it. #4374's AC2 describes only the two new properties; it is not
 *    asking for `source` to be repurposed.
 *
 *    `App Install Click` is web-only with no mobile counterpart, so its builder
 *    does NOT belong in this shared package. It lands in
 *    packages/web/app/lib/app-install-event.ts in the wiring PR.
 *  - `directions` — there is no directions CTA on the gym page. The address is
 *    rendered as plain text (gym/[gym_slug]/page.tsx), not a map link.
 *  - `report-listing` — belongs to #4385 and is out of scope for this epic tier.
 *    Report-a-DUPLICATE is a different, existing CTA and is kept.
 *
 * `manage` (GymPageManageButton, editors only) is also a real gym-page button
 * but is intentionally not a member: it is not part of #4374's vocabulary, and
 * it is an owner action rather than a step in the discovery funnel. Add it here
 * with its own comment if a later PR needs it measured.
 */
export type GymPageCta = 'follow' | 'kiosk' | 'website' | 'report-duplicate';

/**
 * Tabs of the gym management console.
 *
 * SOURCE OF TRUTH: `VALID_TABS` in
 * packages/web/app/gym/[gym_slug]/manage/manage-gym-content.tsx. The union is
 * RESTATED rather than imported because a shared package must never depend on
 * `packages/web`. Keep the two in sync — adding a tab there without adding it
 * here is a compile error at the call site, which is the intended nudge.
 */
export type GymManageTabName =
  | 'overview'
  | 'kiosks'
  | 'insights'
  | 'branding'
  | 'profile'
  | 'boards'
  | 'members'
  | 'comments';

/**
 * A name paired with the exact properties that name expects. Builders return
 * this so a caller cannot hand one event's props to another event's name.
 */
export type GymFunnelPayload<
  TName extends GymFunnelEventName,
  TProperties extends Record<string, AnalyticsPropertyValue>,
> = {
  name: TName;
  properties: TProperties;
};

export type GymClaimCtaClickedInput = {
  placement: GymClaimPlacement;
  viewerState: GymClaimViewerState;
  gymUuid: string;
};

export type GymClaimSubmittedInput = {
  method: GymClaimSubmitMethod;
  gymUuid: string;
};

export type GymClaimResultInput = {
  status: GymClaimResultStatus;
  gymUuid: string;
};

export type GymQrScannedInput = {
  medium: GymQrMedium;
  /** Slug of the gym page the scan landed on — this event only fires on `/gym/[gym_slug]`. */
  gymSlug: string;
};

export type GymPageCtaClickedInput = {
  cta: GymPageCta;
  gymUuid: string;
};

export type GymManageTabViewedInput = {
  tab: GymManageTabName;
};

export type GymDirectorySearchedInput = {
  /** Length of the typed query, never the query text — search terms stay in the browser. */
  queryLength: number;
  /** Board-type filter selection. Serialised to a sorted comma-joined string on the way out. */
  boardTypes: string[];
  /** Whether the search used the climber's location. A boolean and only ever a boolean. */
  hasGeo: boolean;
  resultsCount: number;
};

export function gymClaimCtaClicked(
  input: GymClaimCtaClickedInput,
): GymFunnelPayload<
  typeof GYM_FUNNEL_EVENTS.ClaimCtaClicked,
  { placement: GymClaimPlacement; viewerState: GymClaimViewerState; gymUuid: string }
> {
  return {
    name: GYM_FUNNEL_EVENTS.ClaimCtaClicked,
    properties: {
      placement: input.placement,
      viewerState: input.viewerState,
      gymUuid: input.gymUuid,
    },
  };
}

export function gymClaimSubmitted(
  input: GymClaimSubmittedInput,
): GymFunnelPayload<typeof GYM_FUNNEL_EVENTS.ClaimSubmitted, { method: GymClaimSubmitMethod; gymUuid: string }> {
  return {
    name: GYM_FUNNEL_EVENTS.ClaimSubmitted,
    properties: {
      method: input.method,
      gymUuid: input.gymUuid,
    },
  };
}

// `method` is deliberately NOT repeated here — #4374's contract is
// `{gymUuid, status}`, and PostHog funnels can break a step down by a previous
// step's property, so the path is already recoverable from the paired
// `Gym Claim Submitted`. The one case that loses resolution is `status: 'error'`,
// which cannot say on its own which path threw; add `method` back if that
// breakdown is ever actually needed.
export function gymClaimResult(
  input: GymClaimResultInput,
): GymFunnelPayload<typeof GYM_FUNNEL_EVENTS.ClaimResult, { status: GymClaimResultStatus; gymUuid: string }> {
  return {
    name: GYM_FUNNEL_EVENTS.ClaimResult,
    properties: {
      status: input.status,
      gymUuid: input.gymUuid,
    },
  };
}

export function gymQrScanned(
  input: GymQrScannedInput,
): GymFunnelPayload<typeof GYM_FUNNEL_EVENTS.QrScanned, { medium: GymQrMedium; gymSlug: string }> {
  return {
    name: GYM_FUNNEL_EVENTS.QrScanned,
    properties: {
      medium: input.medium,
      gymSlug: input.gymSlug,
    },
  };
}

export function gymPageCtaClicked(
  input: GymPageCtaClickedInput,
): GymFunnelPayload<typeof GYM_FUNNEL_EVENTS.PageCtaClicked, { cta: GymPageCta; gymUuid: string }> {
  return {
    name: GYM_FUNNEL_EVENTS.PageCtaClicked,
    properties: {
      cta: input.cta,
      gymUuid: input.gymUuid,
    },
  };
}

// `tab` and nothing else, per #4374. A gym identifier on an owner-only console
// view would tie a named gym to one operator's navigation, which is scope this
// event was never asked to carry.
export function gymManageTabViewed(
  input: GymManageTabViewedInput,
): GymFunnelPayload<typeof GYM_FUNNEL_EVENTS.ManageTabViewed, { tab: GymManageTabName }> {
  return {
    name: GYM_FUNNEL_EVENTS.ManageTabViewed,
    properties: {
      tab: input.tab,
    },
  };
}

/**
 * The one builder that transforms rather than copies.
 *
 * `boardTypes` arrives as an array and leaves as a SORTED, comma-joined string.
 * Web's `track()` types its properties as
 * `string | number | boolean | null | undefined`, so the array cannot be handed
 * over as-is — flattening here is what makes the value expressible at all.
 * Sorting makes `['tension','kilter']` and `['kilter','tension']` the same
 * PostHog value so one filter combination is one row instead of N! rows.
 *
 * An empty selection becomes `''`, not `undefined`: an empty string is a real
 * "searched with no board filter" bucket, while `undefined` is stripped by
 * `sanitizeForPosthog` and the property disappears from those events entirely,
 * making "no filter" indistinguishable from "instrumentation missing".
 */
export function gymDirectorySearched(
  input: GymDirectorySearchedInput,
): GymFunnelPayload<
  typeof GYM_FUNNEL_EVENTS.DirectorySearched,
  { queryLength: number; boardTypes: string; hasGeo: boolean; resultsCount: number }
> {
  return {
    name: GYM_FUNNEL_EVENTS.DirectorySearched,
    properties: {
      queryLength: input.queryLength,
      boardTypes: [...input.boardTypes].sort().join(','),
      hasGeo: input.hasGeo,
      resultsCount: input.resultsCount,
    },
  };
}

// ---------------------------------------------------------------------------
// QR landing param contract
// ---------------------------------------------------------------------------
//
// Printed QR codes point at a normal Boardsesh URL with two extra params:
// `?src=qr&medium=<poster|kiosk|board>`. The landing surface reads them, fires
// `Gym QR Scanned` once, then rewrites the URL without them so a shared or
// bookmarked link doesn't re-attribute someone else's visit to a poster.

export const GYM_QR_SRC_PARAM = 'src';
export const GYM_QR_MEDIUM_PARAM = 'medium';
export const GYM_QR_SRC_VALUE = 'qr';

/** Shape of Next.js' `searchParams`: a repeated param arrives as an array. */
export type GymQrSearchParams = Record<string, string | string[] | undefined>;

export type GymQrLanding = {
  medium: GymQrMedium;
};

function isGymQrMedium(candidate: string): candidate is GymQrMedium {
  return (GYM_QR_MEDIUMS as readonly string[]).includes(candidate);
}

/**
 * Recognise a QR landing, or return `null`.
 *
 * Deliberately strict — this decides whether an acquisition event fires, so
 * every ambiguity resolves to "not a QR scan":
 *  - `src` must equal `'qr'` exactly (no trimming, no case folding).
 *  - `medium` must be a known member of `GYM_QR_MEDIUMS`.
 *  - An array-valued `src` or `medium` (`?medium=kiosk&medium=poster`) is
 *    rejected outright rather than picking one, because a duplicated param is a
 *    hand-edited or crawler-mangled URL, not a scan.
 */
export function parseGymQrLanding(searchParams: GymQrSearchParams): GymQrLanding | null {
  // Own properties only. Next's searchParams is a plain object so this is not
  // reachable today, but the function gates an acquisition event and callers
  // will hand it whatever object they have; a `medium` inherited from a
  // prototype must never count as a scan.
  if (!Object.hasOwn(searchParams, GYM_QR_SRC_PARAM)) return null;
  if (!Object.hasOwn(searchParams, GYM_QR_MEDIUM_PARAM)) return null;
  const source = searchParams[GYM_QR_SRC_PARAM];
  const medium = searchParams[GYM_QR_MEDIUM_PARAM];
  if (typeof source !== 'string' || source !== GYM_QR_SRC_VALUE) return null;
  if (typeof medium !== 'string' || !isGymQrMedium(medium)) return null;
  return { medium };
}

/**
 * Build the URL a QR code encodes.
 *
 * This output gets printed on laminated posters and stuck to gym walls, where a
 * wrong href cannot be patched afterwards. Two input shapes broke a naive
 * "append with `?` or `&`" version, so both are handled explicitly:
 *
 *  - A FRAGMENT. `/gym/x#boards` + `?src=qr` appended at the end puts the params
 *    INSIDE the fragment (`/gym/x#boards?src=qr&...`), which never leaves the
 *    browser, so the server sees no params and nothing ever fires. The fragment
 *    is split off first and re-attached last.
 *  - An EXISTING `src` OR `medium`. `/gym/x?src=email` would become
 *    `?src=email&src=qr`, which Next surfaces as a `string[]` — and
 *    `parseGymQrLanding` correctly rejects arrays, so again nothing fires. Any
 *    pre-existing copy of either param is dropped so ours always wins.
 *
 * Every other param is preserved.
 */
export function buildGymQrHref(path: string, medium: GymQrMedium): string {
  const fragmentStart = path.indexOf('#');
  const fragment = fragmentStart === -1 ? '' : path.slice(fragmentStart);
  const pathAndQuery = fragmentStart === -1 ? path : path.slice(0, fragmentStart);

  const queryStart = pathAndQuery.indexOf('?');
  const pathname = queryStart === -1 ? pathAndQuery : pathAndQuery.slice(0, queryStart);
  const params = new URLSearchParams(queryStart === -1 ? '' : pathAndQuery.slice(queryStart + 1));

  params.delete(GYM_QR_SRC_PARAM);
  params.delete(GYM_QR_MEDIUM_PARAM);
  params.append(GYM_QR_SRC_PARAM, GYM_QR_SRC_VALUE);
  params.append(GYM_QR_MEDIUM_PARAM, medium);

  return `${pathname}?${params.toString()}${fragment}`;
}

/** Decode a param NAME for comparison; a malformed `%` escape is left as-is. */
function decodeParamName(rawName: string): string {
  try {
    return decodeURIComponent(rawName.replace(/\+/g, ' '));
  } catch {
    return rawName;
  }
}

/**
 * Drop the two QR params from a search string, keeping every other param, its
 * order, AND its exact original spelling. Accepts the string with or without a
 * leading `?`; returns `''` when nothing is left, otherwise a `?`-prefixed
 * search string ready to hand to `history.replaceState`.
 *
 * Filters the raw `&`-separated pairs rather than round-tripping through
 * `URLSearchParams`, because that round-trip silently re-encodes what it keeps:
 * `?q=hello%20world` comes back as `?q=hello+world`, and a valueless `?embed`
 * comes back as `?embed=`. This result is written straight into the address bar
 * after a QR landing, so an unrelated param must not visibly change shape.
 */
export function stripGymQrParams(search: string): string {
  const query = search.startsWith('?') ? search.slice(1) : search;
  if (query === '') return '';

  const keptPairs = query.split('&').filter((pair) => {
    if (pair === '') return false;
    const rawName = pair.split('=')[0] ?? pair;
    const name = decodeParamName(rawName);
    return name !== GYM_QR_SRC_PARAM && name !== GYM_QR_MEDIUM_PARAM;
  });

  return keptPairs.length === 0 ? '' : `?${keptPairs.join('&')}`;
}
