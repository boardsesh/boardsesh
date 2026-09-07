// Thin wrappers around the first-run link-prompt events, mirroring the shape of
// `onboarding-analytics.ts` so the step component stays free of property-key
// bookkeeping.
//
// The invariant, and the reason the `abandoned` outcome exists at all: **every
// Shown resolves to exactly one Resolved.** The tour learned this the hard way —
// see the `trackTourDismissed` note in `onboarding-analytics.ts`, where ~a third
// of Starts resolved to no terminal outcome and quietly deflated Completed. The
// step's unmount guard reports `abandoned` for the exits no button produced.
//
// The link attempt itself is NOT re-counted here. It reports through the
// `Board Account Link*` events with `source: 'onboarding'`, so the success rate of
// an onboarding link is directly comparable to one started from Settings.

import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { AuroraBoardName } from '@boardsesh/shared-schema';
import { track } from '../analytics';

export type LinkPromptOutcome = 'linked' | 'declined' | 'abandoned';

export function trackLinkPromptShown(boardType: AuroraBoardName): void {
  track(SHARED_EVENTS.OnboardingLinkPromptShown, { boardType });
}

export function trackLinkPromptResolved(boardType: AuroraBoardName, outcome: LinkPromptOutcome): void {
  track(SHARED_EVENTS.OnboardingLinkPromptResolved, { boardType, outcome });
}
