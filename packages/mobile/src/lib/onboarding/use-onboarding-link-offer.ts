import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../../providers/auth-provider';
import { useFeatureFlag } from '../../providers/feature-flags-provider';
import { useIsOffline } from '../../hooks/use-is-offline';
import { useBoardAccountCredentials } from '../integrations/use-board-account-credentials';
import { hasAnsweredLinkStep } from './link-step-answered';
import { shouldOfferLink, type ShouldOfferLinkInput } from './should-offer-link';

/** Preload while picking; read the latest eligibility after binding/download completes. */
export function useOnboardingLinkOffer(fromOnboarding: boolean): (boardType: string) => boolean {
  const { isAuthenticated } = useAuth();
  const flagEnabled = useFeatureFlag('board-link-onboarding-step') === true;
  const enabled = fromOnboarding && isAuthenticated && flagEnabled;
  const isOffline = useIsOffline();
  const { data: credentials } = useBoardAccountCredentials(enabled);
  const [answered, setAnswered] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    setAnswered(undefined);
    if (!enabled) return;
    let cancelled = false;
    void hasAnsweredLinkStep().then((hasAnswered) => {
      if (!cancelled) setAnswered(hasAnswered);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  const latest = useRef<Omit<ShouldOfferLinkInput, 'boardType'>>({
    enabled,
    isOffline,
    answered,
    hasLinkedAccount: undefined,
  });
  latest.current = {
    enabled,
    isOffline,
    answered,
    hasLinkedAccount: credentials === undefined ? undefined : credentials.length > 0,
  };
  return useCallback((boardType: string) => shouldOfferLink({ ...latest.current, boardType }) === 'show', []);
}
