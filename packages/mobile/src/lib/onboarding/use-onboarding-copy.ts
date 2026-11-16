import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

export type OnboardingPromptCopy = {
  title: string;
  body: string;
  footnote: string;
  continueLabel: string;
};

export type OnboardingBoardCopy = {
  title: string;
  body: string;
  offlineHint: string;
  findAnother: string;
  findFirst: string;
  offlineSkip: string;
};

/**
 * Resolves the framing screen's translated copy. Every key is a STATIC `t()`
 * literal — the project lint hard-fails on `t(variable)` and the i18n orphan
 * checker only sees literal keys. Memoised on the translator.
 */
export function useOnboardingCopy(): OnboardingPromptCopy {
  const { t } = useTranslation('common');
  return useMemo(
    () => ({
      title: t('mobile.onboarding.prompt.title'),
      body: t('mobile.onboarding.prompt.body'),
      footnote: t('mobile.onboarding.prompt.footnote'),
      continueLabel: t('mobile.onboarding.prompt.continue'),
    }),
    [t],
  );
}

/** The board step's copy. Same static-literal rule as above. */
export function useOnboardingBoardCopy(): OnboardingBoardCopy {
  const { t } = useTranslation('common');
  return useMemo(
    () => ({
      title: t('mobile.onboarding.board.title'),
      body: t('mobile.onboarding.board.body'),
      offlineHint: t('mobile.onboarding.board.offlineHint'),
      findAnother: t('mobile.onboarding.board.findAnother'),
      findFirst: t('mobile.onboarding.board.findFirst'),
      offlineSkip: t('mobile.onboarding.board.offlineSkip'),
    }),
    [t],
  );
}
