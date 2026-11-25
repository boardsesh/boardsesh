'use client';

import { useTranslation } from 'react-i18next';
import ConsentPrompt, { type ConsentPromptProps } from './consent-prompt';
import { getConsentLabels } from './consent-labels';

export default function ConsentBanner({ children }: Pick<ConsentPromptProps, 'children'>) {
  const { t } = useTranslation('consent');
  return <ConsentPrompt labels={getConsentLabels(t)}>{children}</ConsentPrompt>;
}
