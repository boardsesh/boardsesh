// Thin wrappers around the shared onboarding-tour events so the carousel
// component stays free of property-key bookkeeping. Property names mirror web's
// onboarding-tour-provider exactly (stepId/stepIndex, fromStepId/toStepId/
// trigger, durationSeconds, atStepId) so both platforms feed one PostHog funnel.

import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../analytics';
import { ONBOARDING_TOTAL_STEPS, type OnboardingCard } from './onboarding-cards';

// The mobile tour is a single framing screen: Started + one Step Viewed on
// mount, then exactly one terminal outcome — Completed (the primary CTA) or
// Dismissed (a nav-away without choosing). There's no multi-step advance, so
// `trackStepAdvanced` was removed.
//
// There is no Skipped wrapper any more either: issue #4961 made the flow
// mandatory and deleted the "look around" exit, so no code path can produce one.
// `SHARED_EVENTS.OnboardingTourSkipped` stays defined for web and for the
// historical funnel; mobile simply never emits it.
//
// Note what Completed does and does not claim. It says the climber read the
// framing card and moved on — nothing more. The metric for a board actually
// bound is `Onboarding Board Activated`, fired from `useActivateBoard`.

export function trackTourStarted(): void {
  // The mobile tour always starts fresh on a first run (no resume / restart
  // semantics), and the only entry points are the first-run gate and the
  // More-tab replay row. Keep the web property shape, filled for mobile.
  track(SHARED_EVENTS.OnboardingTourStarted, {
    resumed: false,
    restartedFrom: '',
    source: 'mobile-first-run',
  });
}

export function trackStepViewed(card: OnboardingCard, stepIndex: number): void {
  track(SHARED_EVENTS.OnboardingTourStepViewed, {
    stepId: card.id,
    stepIndex,
    totalSteps: ONBOARDING_TOTAL_STEPS,
  });
}

export function trackTourCompleted(durationSeconds: number): void {
  track(SHARED_EVENTS.OnboardingTourCompleted, { durationSeconds });
}

// Fired when the prompt unmounts without the user pressing the button — now only
// a programmatic nav-away, since Android hardware-back is swallowed. Without
// this, ~a third of first-run Starts resolved to no terminal outcome at all,
// deflating Completed. `exitReason: 'unresolved'` stays mechanism-neutral: the
// guard can't tell one unmount cause from another, so it claims neither.
export function trackTourDismissed(card: OnboardingCard, stepIndex: number): void {
  track(SHARED_EVENTS.OnboardingTourDismissed, {
    atStepId: card.id,
    stepIndex,
    exitReason: 'unresolved',
  });
}
