import type { TFunction } from 'i18next';

const QUESTION_IDS = [
  'operator',
  'funding',
  'compatibility',
  'import',
  'password',
  'shutdown',
  'tracking',
  'sprayPrivacy',
] as const;

export function createTrustFaqCopy(t: TFunction<'marketing'>, limit: 6 | 8) {
  return {
    title: t('trust.title'),
    legal: t('trust.legal'),
    import: t('trust.import'),
    privacy: t('trust.privacy'),
    questions: QUESTION_IDS.slice(0, limit).map((id) => ({
      id,
      question: t(`trust.questions.${id}.question`),
      answer: id === 'funding' ? t('funding.body') : t(`trust.questions.${id}.answer`),
    })),
  };
}

export type TrustFaqCopy = ReturnType<typeof createTrustFaqCopy>;
