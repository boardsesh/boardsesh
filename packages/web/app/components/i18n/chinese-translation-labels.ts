import type { TFunction } from 'i18next';

export function getChineseTranslationLabels(t: TFunction<'common'>) {
  return {
    title: t('chineseTranslation.title'),
    body: t('chineseTranslation.body'),
    terms: t('chineseTranslation.terms'),
    invitation: t('chineseTranslation.invitation'),
    formPending: t('chineseTranslation.formPending'),
    continue: t('chineseTranslation.continue'),
    openForm: t('chineseTranslation.openForm'),
  };
}

export type ChineseTranslationLabels = ReturnType<typeof getChineseTranslationLabels>;
