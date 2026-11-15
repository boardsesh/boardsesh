import { useCallback, useEffect, useRef } from 'react';
import { hapticSelection } from '../../lib/haptics';
import {
  trackStepViewed,
  trackTourCompleted,
  trackTourDismissed,
  trackTourStarted,
} from '../../lib/onboarding/onboarding-analytics';
import { ONBOARDING_PROMPT_CARD } from '../../lib/onboarding/onboarding-cards';
import { OnboardingPromptView, type OnboardingPromptViewProps } from './OnboardingPromptView';
import { useBlockBack } from './use-block-back';
export function OnboardingPrompt(props: Omit<OnboardingPromptViewProps, 'onImageDisplayed' | 'onImageError'>) {
  const { onContinue } = props;
  const startedAtRef = useRef<number>(Date.now());
  // Tracks whether the user chose a button. Android back is now swallowed, but a
  // nav-away (a deep link arriving mid-step) can still unmount this without an
  // answer, and the cleanup fires Dismissed so the Start resolves to a terminal
  // outcome either way.
  const resolvedRef = useRef(false);

  useBlockBack();

  // Tour Started + the single Step Viewed fire once on mount. On unmount, if no
  // button resolved the prompt, fire Dismissed (the back/kill exit).
  useEffect(() => {
    startedAtRef.current = Date.now();
    trackTourStarted();
    trackStepViewed(ONBOARDING_PROMPT_CARD, 0);
    return () => {
      if (!resolvedRef.current) {
        trackTourDismissed(ONBOARDING_PROMPT_CARD, 0);
      }
    };
  }, []);

  // Completed means "read the framing and moved on", which is all this one card
  // can attest to. The activation metric — a named board actually bound — is
  // `Onboarding Board Activated`, fired from the bind itself.
  const handleContinue = useCallback(() => {
    resolvedRef.current = true;
    const durationSeconds = Math.max(0, Math.round((Date.now() - startedAtRef.current) / 1000));
    trackTourCompleted(durationSeconds);
    hapticSelection();
    onContinue();
  }, [onContinue]);

  return <OnboardingPromptView {...props} onContinue={handleContinue} />;
}
