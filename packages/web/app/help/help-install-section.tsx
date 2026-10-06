'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import MarketingInstallLinks from '@/app/components/marketing/marketing-install-links';
import { PageSection } from '@/app/components/ui/page-shell';

/**
 * The store button at the foot of a help sub-page (#6027).
 *
 * Each of the seven pages explains something that only happens in the app, and
 * until this none of them linked to a store: a reader who arrived from a search
 * had to find their way back to /help to get one. Same `help` placement as the
 * index, so the pathname on the click is what tells the pages apart.
 */
export default function HelpInstallSection() {
  const { t } = useTranslation('marketing');

  return (
    <PageSection id="get-the-app" title={t('help.install.title')} lead={t('help.install.intro')}>
      <MarketingInstallLinks placement="help" />
    </PageSection>
  );
}
