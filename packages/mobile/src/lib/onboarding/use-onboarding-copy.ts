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
  downloadLabelFor: (name: string) => string;
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

/**
 * The board step's copy. Same static-literal rule as above.
 *
 * `downloadLabelFor` is a function rather than a string because the download
 * glyph's accessibility label names the board it would download. Building it
 * inside the memo keeps `BoardCarousel`'s `downloadLabelFor` prop referentially
 * stable, so its `renderItem` doesn't rebuild every card on every commit.
 */
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
      downloadLabelFor: (name: string) => t('mobile.onboarding.board.downloadAria', { name }),
    }),
    [t],
  );
}
