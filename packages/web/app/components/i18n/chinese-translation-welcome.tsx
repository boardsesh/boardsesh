'use client';

import { useEffect, useState, type ComponentType } from 'react';
import { chineseTranslationOnboardingKey, getChineseTerminologyFormUrl } from '@boardsesh/i18n';
import { getPreference, setPreference } from '@/app/lib/user-preferences-db';
import { usePathnameWithoutLocale } from '@/app/lib/i18n/use-locale-router';
import { isChromeLessPath } from '@/app/lib/chrome-less-routes';
import { useConsent } from '../consent/consent-state-provider';
import type { ConsentRegionPromptState } from '../consent/use-consent-region-prompt';
import { loadChineseTranslationDialog } from './chinese-translation-dialog-loader';
import type { ChineseTranslationDialogProps } from './chinese-translation-dialog';
import type { ChineseTranslationLabels } from './chinese-translation-labels';

function EligibleChineseTranslationWelcome({
  labels,
  formUrl,
  preferenceKey,
}: {
  labels: ChineseTranslationLabels;
  formUrl: string | null;
  preferenceKey: string;
}) {
  const [TranslationDialog, setTranslationDialog] = useState<ComponentType<ChineseTranslationDialogProps> | null>(null);
  useEffect(() => {
    let mounted = true;
    void getPreference<boolean>(preferenceKey)
      .then(async (seen) => {
        if (!mounted || seen === true || document.visibilityState !== 'visible') return;
        const { default: LoadedDialog } = await loadChineseTranslationDialog();
        if (mounted) setTranslationDialog(() => LoadedDialog);
      })
      .catch(() => {
        /* This optional welcome must not interrupt the page when offline. */
      });
    return () => {
      mounted = false;
    };
  }, [preferenceKey]);
  const dismiss = () => {
    setTranslationDialog(null);
    void setPreference(preferenceKey, true);
  };
  return TranslationDialog ? <TranslationDialog labels={labels} formUrl={formUrl} onDismiss={dismiss} /> : null;
}

/** Keep the optional welcome's dialog graph out of every other visitor's payload. */
export default function ChineseTranslationWelcome({
  consentRegion,
  labels,
}: {
  consentRegion: ConsentRegionPromptState;
  labels: ChineseTranslationLabels;
}) {
  const formUrl = getChineseTerminologyFormUrl(process.env.NEXT_PUBLIC_CHINESE_TERMINOLOGY_FORM_URL);
  const preferenceKey = chineseTranslationOnboardingKey(formUrl);
  const pathname = usePathnameWithoutLocale();
  const { dialogOpen, accountReady } = useConsent();
  const [visible, setVisible] = useState(false);
  const eligible =
    !isChromeLessPath(pathname.toLowerCase()) &&
    consentRegion.settled &&
    !consentRegion.prompt &&
    !dialogOpen &&
    accountReady &&
    visible;

  useEffect(() => {
    const refreshVisibility = () => setVisible(document.visibilityState === 'visible');
    refreshVisibility();
    document.addEventListener('visibilitychange', refreshVisibility);
    return () => document.removeEventListener('visibilitychange', refreshVisibility);
  }, []);

  return eligible ? (
    <EligibleChineseTranslationWelcome
      key={preferenceKey}
      labels={labels}
      formUrl={formUrl}
      preferenceKey={preferenceKey}
    />
  ) : null;
}
