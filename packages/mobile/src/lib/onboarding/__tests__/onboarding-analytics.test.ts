import { describe, it, expect, vi, beforeEach } from 'vitest';

const trackMock = vi.hoisted(() => vi.fn());
vi.mock('../../analytics', () => ({ track: trackMock }));

import { trackStepViewed, trackTourCompleted, trackTourSkipped, trackTourStarted } from '../onboarding-analytics';
import { ONBOARDING_PROMPT_CARD, ONBOARDING_TOTAL_STEPS } from '../onboarding-cards';

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
    trackStepViewed(ONBOARDING_PROMPT_CARD, 0);
    expect(trackMock).toHaveBeenCalledWith('Onboarding Tour Step Viewed', {
      stepId: ONBOARDING_PROMPT_CARD.id,
      stepIndex: 0,
      totalSteps: ONBOARDING_TOTAL_STEPS,
    });
  });

  it('fires "Onboarding Tour Completed" with durationSeconds', () => {
    trackTourCompleted(42);
    expect(trackMock).toHaveBeenCalledWith('Onboarding Tour Completed', { durationSeconds: 42 });
  });

  it('fires "Onboarding Tour Skipped" with atStepId/stepIndex', () => {
    trackTourSkipped(ONBOARDING_PROMPT_CARD, 0);
    expect(trackMock).toHaveBeenCalledWith('Onboarding Tour Skipped', {
      atStepId: ONBOARDING_PROMPT_CARD.id,
      stepIndex: 0,
    });
  });
});
