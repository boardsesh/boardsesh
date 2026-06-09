// Thin wrappers around the shared onboarding-tour events so the carousel
// component stays free of property-key bookkeeping. Property names mirror web's
// onboarding-tour-provider exactly (stepId/stepIndex, fromStepId/toStepId/
// trigger, durationSeconds, atStepId) so both platforms feed one PostHog funnel.

import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../analytics';
import { ONBOARDING_TOTAL_STEPS, type OnboardingCard } from './onboarding-cards';

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

export function trackStepAdvanced(fromCard: OnboardingCard, toCard: OnboardingCard, trigger: 'next' | 'swipe'): void {
  track(SHARED_EVENTS.OnboardingTourStepAdvanced, {
    fromStepId: fromCard.id,
    toStepId: toCard.id,
    trigger,
  });
}

export function trackTourCompleted(durationSeconds: number): void {
  track(SHARED_EVENTS.OnboardingTourCompleted, { durationSeconds });
}

export function trackTourSkipped(card: OnboardingCard, stepIndex: number): void {
  track(SHARED_EVENTS.OnboardingTourSkipped, {
    atStepId: card.id,
    stepIndex,
  });
}
