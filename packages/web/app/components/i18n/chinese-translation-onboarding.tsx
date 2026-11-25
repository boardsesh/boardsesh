'use client';

import { isChineseTranslationLocale } from '@boardsesh/i18n';
import { useTranslation } from 'react-i18next';
import type { ConsentRegionPromptState } from '../consent/use-consent-region-prompt';
import { getChineseTranslationLabels } from './chinese-translation-labels';
import ChineseTranslationWelcome from './chinese-translation-welcome';

export default function ChineseTranslationOnboarding({ consentRegion }: { consentRegion: ConsentRegionPromptState }) {
  const { i18n, t } = useTranslation('common');
  if (!isChineseTranslationLocale(i18n.language)) return null;
  return <ChineseTranslationWelcome labels={getChineseTranslationLabels(t)} consentRegion={consentRegion} />;
}
