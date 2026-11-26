'use client';

import { useTranslation } from 'react-i18next';
import { useDocumentLocale } from '@/app/lib/i18n/document-locale-context';
import { getSiteFooterLabels } from './site-footer-labels';
import SiteFooterView from './site-footer-view';

export default function SiteFooter({ developerHref }: { developerHref?: '/developers' | '/docs' }) {
  const { t } = useTranslation('common');
  const { t: consentTranslation } = useTranslation('consent');
  const locale = useDocumentLocale();
  const labels = getSiteFooterLabels(t, consentTranslation('privacyChoices'), locale);
  return <SiteFooterView labels={labels} developerHref={developerHref} />;
}
