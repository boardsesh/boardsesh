// The www support-page event contract.
//
// www-only, like the gym funnel: the app never shows these buttons (its own
// support link is `SHARED_EVENTS.SupportLinkTapped`). One event, fired when a
// visitor clicks any button on /support that leaves for Stripe or GitHub
// Sponsors. The click opens a new tab, so `track()` has time to send.
//
// What it never carries: an amount, a price, a tier label, or the link itself.
// Labels come from runtime env and name amounts, so `option` is the button's
// position in its list instead.

import type { AnalyticsPropertyValue } from './client';

export const SUPPORT_EVENTS = {
  CtaClicked: 'Support CTA Clicked',
} as const;

export type SupportEventName = (typeof SUPPORT_EVENTS)[keyof typeof SUPPORT_EVENTS];

/** `sponsors` is GitHub Sponsors; `monthly` and `once` are Stripe Payment Links. */
export type SupportCadence = 'monthly' | 'once' | 'sponsors';

/** `none` for GitHub Sponsors, which picks its own currency. */
export type SupportCtaCurrency = 'aud' | 'usd' | 'none';

/** `hero` is the button under the page title; `options` is the card list below it. */
export type SupportCtaPlacement = 'hero' | 'options';

export type SupportCtaClickedInput = {
  cadence: SupportCadence;
  currency: SupportCtaCurrency;
  /** The sanitised `?src=` the page was opened with (`web-support` by default). */
  src: string;
  /** 1-based position in the monthly list; 1 for a single button. */
  option: number;
  placement: SupportCtaPlacement;
};

export type SupportEventPayload = {
  name: SupportEventName;
  properties: Record<string, AnalyticsPropertyValue>;
};

export function supportCtaClicked(input: SupportCtaClickedInput): SupportEventPayload {
  return {
    name: SUPPORT_EVENTS.CtaClicked,
    properties: {
      cadence: input.cadence,
      currency: input.currency,
      src: input.src,
      option: input.option,
      placement: input.placement,
    },
  };
}
