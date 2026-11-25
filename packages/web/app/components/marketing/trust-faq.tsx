'use client';

import { useTranslation } from 'react-i18next';
import { createTrustFaqCopy } from './trust-faq-copy';
import TrustFaqContent from './trust-faq-content';

/** Application pages retain their existing browser translation provider. */
export default function TrustFaq({ limit = 8 }: { limit?: 6 | 8 }) {
  const { t } = useTranslation('marketing');
  return <TrustFaqContent copy={createTrustFaqCopy(t, limit)} />;
}
