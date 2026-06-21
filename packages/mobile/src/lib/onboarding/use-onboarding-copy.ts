import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

export type OnboardingPromptCopy = {
  title: string;
  body: string;
  footnote: string;
  findBoard: string;
  lookAround: string;
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
      findBoard: t('mobile.onboarding.prompt.findBoard'),
      lookAround: t('mobile.onboarding.prompt.lookAround'),
    }),
    [t],
  );
}
