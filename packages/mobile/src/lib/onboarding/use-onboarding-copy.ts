import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { OnboardingCardId } from './onboarding-cards';

export type OnboardingCardCopy = { title: string; body: string };

/**
 * Resolves the four cards' translated copy keyed by card id. Every key is a
 * STATIC `t()` literal — the project lint hard-fails on `t(variable)` and the
 * i18n orphan checker only sees literal keys, so we can't fold these into the
 * card data and resolve them dynamically. Memoised on the translator so the
 * carousel's `renderItem` reads from a stable map.
 */
export function useOnboardingCopy(): Record<OnboardingCardId, OnboardingCardCopy> {
  const { t } = useTranslation('common');
  return useMemo(
    () => ({
      welcome: {
        title: t('mobile.onboarding.cards.welcome.title'),
        body: t('mobile.onboarding.cards.welcome.body'),
      },
      connect: {
        title: t('mobile.onboarding.cards.connect.title'),
        body: t('mobile.onboarding.cards.connect.body'),
      },
      find: {
        title: t('mobile.onboarding.cards.find.title'),
        body: t('mobile.onboarding.cards.find.body'),
      },
      play: {
        title: t('mobile.onboarding.cards.play.title'),
        body: t('mobile.onboarding.cards.play.body'),
      },
    }),
    [t],
  );
}
