import { describe, it, expect, vi, beforeEach } from 'vitest';

const trackMock = vi.hoisted(() => vi.fn());
vi.mock('../../analytics', () => ({ track: trackMock }));

import {
  trackStepAdvanced,
  trackStepViewed,
  trackTourCompleted,
  trackTourSkipped,
  trackTourStarted,
} from '../onboarding-analytics';
import { ONBOARDING_CARDS, ONBOARDING_TOTAL_STEPS } from '../onboarding-cards';

describe('onboarding analytics', () => {
  beforeEach(() => trackMock.mockClear());

  // The event NAMES must match web's onboarding-tour-provider so both platforms
  // share one PostHog funnel — assert the literal strings, not a re-export.
  it('fires "Onboarding Tour Started" with the web property shape', () => {
    trackTourStarted();
    expect(trackMock).toHaveBeenCalledWith('Onboarding Tour Started', {
      resumed: false,
      restartedFrom: '',
      source: 'mobile-first-run',
    });
  });

  it('fires "Onboarding Tour Step Viewed" with stepId/stepIndex/totalSteps', () => {
    trackStepViewed(ONBOARDING_CARDS[1], 1);
    expect(trackMock).toHaveBeenCalledWith('Onboarding Tour Step Viewed', {
      stepId: ONBOARDING_CARDS[1].id,
      stepIndex: 1,
      totalSteps: ONBOARDING_TOTAL_STEPS,
    });
  });

  it('fires "Onboarding Tour Step Advanced" with fromStepId/toStepId/trigger', () => {
    trackStepAdvanced(ONBOARDING_CARDS[0], ONBOARDING_CARDS[1], 'swipe');
    expect(trackMock).toHaveBeenCalledWith('Onboarding Tour Step Advanced', {
      fromStepId: ONBOARDING_CARDS[0].id,
      toStepId: ONBOARDING_CARDS[1].id,
      trigger: 'swipe',
    });
  });

  it('fires "Onboarding Tour Completed" with durationSeconds', () => {
    trackTourCompleted(42);
    expect(trackMock).toHaveBeenCalledWith('Onboarding Tour Completed', { durationSeconds: 42 });
  });

  it('fires "Onboarding Tour Skipped" with atStepId/stepIndex', () => {
    trackTourSkipped(ONBOARDING_CARDS[2], 2);
    expect(trackMock).toHaveBeenCalledWith('Onboarding Tour Skipped', {
      atStepId: ONBOARDING_CARDS[2].id,
      stepIndex: 2,
    });
  });
});
