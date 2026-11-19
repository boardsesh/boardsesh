import { useEffect, useRef } from 'react';
import { useSegments } from 'expo-router';
import { useTranslation } from 'react-i18next';
import {
  chineseTranslationOnboardingKey,
  getChineseTerminologyFormUrl,
  isChineseTranslationLocale,
} from '@boardsesh/i18n';
import { useChoose } from '../../providers/dialog-provider';
import { useLaunchReady } from '../../providers/launch-ready-context';
import { useConsentSettled } from '../../lib/consent-hooks';
import { hasSeenTip, markTipSeen } from '../../lib/onboarding/onboarding-storage';
import { openExternalUrl } from '../../lib/open-url';
import { reportError } from '../../lib/error-reporting';

/** Separate from board setup, so switching an existing account to Chinese also asks. */
export function ChineseTranslationOnboarding({
  onboardingDecided,
  firstBoardPickerPresented = false,
}: {
  onboardingDecided: boolean;
  firstBoardPickerPresented?: boolean;
}) {
  const formUrl = getChineseTerminologyFormUrl(process.env.EXPO_PUBLIC_CHINESE_TERMINOLOGY_FORM_URL);
  const { t, i18n } = useTranslation('common');
  const choose = useChoose();
  const ready = useLaunchReady();
  const consentSettled = useConsentSettled();
  const segments: readonly string[] = useSegments();
  const presented = useRef(false);
  const pickerRouteSeen = useRef(false);
  if (!firstBoardPickerPresented) pickerRouteSeen.current = false;
  if (firstBoardPickerPresented && segments[0] === 'boards') pickerRouteSeen.current = true;
  const eligible =
    ready &&
    consentSettled &&
    onboardingDecided &&
    (!firstBoardPickerPresented || pickerRouteSeen.current) &&
    isChineseTranslationLocale(i18n.language) &&
    (segments[0] === '(tabs)' || (segments[0] === 'settings' && segments[1] === 'general'));

  useEffect(() => {
    if (!eligible || presented.current) return;
    let cancelled = false;
    void (async () => {
      const key = chineseTranslationOnboardingKey(formUrl);
      if (await hasSeenTip(key)) return;
      if (cancelled || presented.current) return;
      presented.current = true;
      const choice = await choose({
        title: t('chineseTranslation.title'),
        message: [
          t('chineseTranslation.body'),
          t('chineseTranslation.terms'),
          formUrl ? t('chineseTranslation.invitation') : t('chineseTranslation.formPending'),
        ].join('\n\n'),
        options: [
          ...(formUrl ? [{ value: 'form', label: t('chineseTranslation.openForm') }] : []),
          { value: 'continue', label: t('chineseTranslation.continue'), cancel: true },
        ],
        cancelValue: 'continue',
      });
      // Start opening during the choice's user activation, before async storage
      // can make a browser target treat this as an unsolicited popup.
      const opening =
        choice === 'form' && formUrl ? openExternalUrl(formUrl, 'chinese-translation-onboarding') : Promise.resolve();
      await markTipSeen(key).catch(reportError);
      await opening;
    })().catch(reportError);
    return () => {
      cancelled = true;
    };
  }, [eligible, choose, t, formUrl]);

  return null;
}
