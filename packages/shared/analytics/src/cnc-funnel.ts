// The CNC build-pack funnel event contract (plan section B6).
//
// One purchase journey — land on /build-plans, configure a wall, sign in, pay,
// download the pack — is measured across a server page, a client configurator
// and the backend's Stripe webhook. Every one of those call sites imports this
// module instead of typing a string literal, because a single character of
// drift splits the funnel into two PostHog events nobody notices until someone
// tries to read the conversion rate.
//
// Why here and not in `events.ts`: `SHARED_EVENTS` is scoped to events fired by
// BOTH web and mobile, and that scoping is what makes it useful. Build plans are
// a www surface with no mobile counterpart (the plan's B1 says so explicitly:
// "No mobile changes"), so they live in their own module — the same reasoning,
// and the same shape, as `gym-funnel.ts`.
//
// The contract in one paragraph:
//
//  * Names live in `CNC_FUNNEL_EVENTS`. Never inline the string.
//  * Props come from the builders below, which return `{ name, properties }`
//    TOGETHER, so a caller physically cannot pair one event's props with
//    another event's name.
//  * Property names are snake_case here, unlike `gym-funnel.ts`'s camelCase.
//    That is deliberate and matches `board-render-events.ts`: the two properties
//    this funnel will most often be broken down by — `board_name`, `size_id` —
//    already exist in PostHog under those exact names from the board-render
//    contract (docs/board-render-analytics.md), and a second spelling of
//    `board_name` would make a cross-surface breakdown silently drop rows.
//  * Property VALUES are identifiers, never copy: never translated, never
//    title-cased, never derived from what the buyer typed. The licensee's name,
//    email and customer site name are personal data and appear in NO event here.
//  * Every value is `string | number | boolean`, because web's `track()`
//    (packages/web/app/lib/analytics.ts) types properties that way — an array or
//    a nested object is a compile error at the call site.

import type { AnalyticsPropertyValue } from './client';

/**
 * Canonical event names. `as const` so the values are literal types and a typo
 * at a call site is a compile error rather than a new PostHog event.
 *
 * `PackPurchased` and `PackDownloaded` have no builder here: both are fired by
 * the BACKEND, from its own `BackendAnalyticsEvent` union
 * (packages/backend/src/services/analytics/posthog.ts), where a purchase is
 * confirmed by the Stripe webhook and a download by the authenticated stream
 * route. Neither event can be trusted from a browser — a client-side "purchased"
 * is a claim, not a payment. They are listed anyway because this file is where
 * someone reading the funnel looks for the full step list, and a name that
 * exists in two places has to be spelled identically in both.
 */
export const CNC_FUNNEL_EVENTS = {
  PageViewed: 'Build Plans Page Viewed',
  ConfiguratorChanged: 'Build Plans Configurator Changed',
  ArtworkPlaced: 'Build Plans Artwork Placed',
  CheckoutStarted: 'Build Plans Checkout Started',
  /** Backend-fired, on `checkout.session.completed`. */
  PackPurchased: 'Build Plans Pack Purchased',
  /** Backend-fired, by the authenticated download route. */
  PackDownloaded: 'Build Plans Pack Downloaded',
} as const;

export type CncFunnelEventKey = keyof typeof CNC_FUNNEL_EVENTS;
export type CncFunnelEventName = (typeof CNC_FUNNEL_EVENTS)[CncFunnelEventKey];

/**
 * Which licence the buyer is looking at or buying.
 *
 * Restates `CncLicenceTier` from `@boardsesh/shared-schema` rather than
 * importing it: a shared package may depend on other shared packages, and this
 * one deliberately depends on none — `@boardsesh/analytics` is imported by
 * mobile, and pulling the whole GraphQL type surface in behind one union would
 * put every schema change on Metro's critical path. Two members, and adding a
 * third to the schema without adding it here is a compile error at the call
 * site, which is the intended nudge.
 */
export type CncTier = 'personal' | 'commercial_single';

/**
 * Which step of the configurator moved.
 *
 * The step vocabulary, not the field name: `Configurator Changed` fires on step
 * COMPLETION, not per keystroke, so "the buyer got as far as options" is the
 * question it answers. A per-field event would drown the funnel in noise from
 * eleven manufacturing selects and tell nobody where people give up.
 *
 * `licensee` deliberately reports only that the step was completed. Nothing
 * about who they are leaves the browser.
 */
export type CncConfiguratorStep = 'board' | 'size' | 'kicker' | 'options' | 'engrave' | 'licensee' | 'tier';

/**
 * A name paired with the exact properties that name expects. Builders return
 * this so a caller cannot hand one event's props to another event's name.
 */
export type CncFunnelPayload<
  TName extends CncFunnelEventName,
  TProperties extends Record<string, AnalyticsPropertyValue>,
> = {
  name: TName;
  properties: TProperties;
};

/**
 * The board tuple every event in this funnel carries.
 *
 * Present on the page view too, where nothing is configured yet: the page
 * defaults the configurator to the first catalogue entry, so "which wall did
 * people arrive looking at" is a real question with a real answer, and a funnel
 * whose first step lacks the breakdown property cannot be broken down at all.
 */
export type CncConfigProps = {
  board_name: string;
  layout_id: number;
  size_id: number;
  /** Whether the wall being configured includes the kicker panels. */
  kicker: boolean;
  has_artwork: boolean;
};

export type CncPageViewedInput = {
  config: CncConfigProps;
  /** Catalogue version the prices and option lists came from. */
  catalog_version: string;
};

export type CncConfiguratorChangedInput = {
  step: CncConfiguratorStep;
  config: CncConfigProps;
};

export type CncArtworkPlacedInput = {
  config: CncConfigProps;
  /** How many artwork items sit on the wall AFTER this placement. */
  artwork_count: number;
};

export type CncCheckoutStartedInput = {
  config: CncConfigProps;
  tier: CncTier;
  /** Price shown at the moment Buy was pressed, in cents of `currency`. */
  amount_cents: number;
  currency: string;
};

export function cncBuildPlansPageViewed(
  input: CncPageViewedInput,
): CncFunnelPayload<typeof CNC_FUNNEL_EVENTS.PageViewed, CncConfigProps & { catalog_version: string }> {
  return {
    name: CNC_FUNNEL_EVENTS.PageViewed,
    properties: { ...input.config, catalog_version: input.catalog_version },
  };
}

export function cncConfiguratorChanged(
  input: CncConfiguratorChangedInput,
): CncFunnelPayload<typeof CNC_FUNNEL_EVENTS.ConfiguratorChanged, CncConfigProps & { step: CncConfiguratorStep }> {
  return {
    name: CNC_FUNNEL_EVENTS.ConfiguratorChanged,
    properties: { ...input.config, step: input.step },
  };
}

export function cncArtworkPlaced(
  input: CncArtworkPlacedInput,
): CncFunnelPayload<typeof CNC_FUNNEL_EVENTS.ArtworkPlaced, CncConfigProps & { artwork_count: number }> {
  return {
    name: CNC_FUNNEL_EVENTS.ArtworkPlaced,
    properties: { ...input.config, artwork_count: input.artwork_count },
  };
}

/**
 * Fired when the buyer presses Buy and the checkout mutation is sent — not when
 * Stripe answers. The paired confirmation is the backend's
 * `Build Plans Pack Purchased`, so the drop between the two is exactly "opened
 * Stripe and did not pay", which is the number worth watching.
 */
export function cncCheckoutStarted(
  input: CncCheckoutStartedInput,
): CncFunnelPayload<
  typeof CNC_FUNNEL_EVENTS.CheckoutStarted,
  CncConfigProps & { tier: CncTier; amount_cents: number; currency: string }
> {
  return {
    name: CNC_FUNNEL_EVENTS.CheckoutStarted,
    properties: {
      ...input.config,
      tier: input.tier,
      amount_cents: input.amount_cents,
      currency: input.currency,
    },
  };
}
