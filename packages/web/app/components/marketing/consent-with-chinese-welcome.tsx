'use client';

import type { ConsentLabels } from '../consent/consent-labels';
import ConsentPrompt from '../consent/consent-prompt';
import type { ChineseTranslationLabels } from '../i18n/chinese-translation-labels';
import ChineseTranslationWelcome from '../i18n/chinese-translation-welcome';

export default function ConsentWithChineseWelcome({
  labels,
  welcomeLabels,
}: {
  labels: ConsentLabels;
  welcomeLabels: ChineseTranslationLabels;
}) {
  return (
    <ConsentPrompt labels={labels}>
      {(consentRegion) => <ChineseTranslationWelcome consentRegion={consentRegion} labels={welcomeLabels} />}
    </ConsentPrompt>
  );
}
