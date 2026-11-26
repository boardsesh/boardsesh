import type { TFunction } from 'i18next';

export function getConsentLabels(t: TFunction<'consent'>) {
  return {
    title: t('title'),
    privacyChoices: t('privacyChoices'),
    bannerSummary: t('bannerSummary'),
    details: t('details'),
    close: t('close'),
    allow: t('allow'),
    deny: t('deny'),
    body: t('body'),
    adMeasurement: t('adMeasurement'),
    privacyLink: t('privacyLink'),
    syncError: t('syncError'),
  };
}

export type ConsentLabels = ReturnType<typeof getConsentLabels>;
