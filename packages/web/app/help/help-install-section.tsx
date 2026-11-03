'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import MarketingInstallLinks from '@/app/components/marketing/marketing-install-links';
import HelpBand from './help-band';

/**
 * The store buttons at the foot of a help sub-page (#6027), and the hub's
 * "Get the app" band.
 *
 * Each guide explains something that only happens in the app, and until this
 * none of them linked to a store: a reader who arrived from a search had to
 * find their way back to /help to get one. Same `help` placement as the hub,
 * so the pathname on the click is what tells the pages apart.
 */
export default function HelpInstallSection({ media }: { media?: React.ReactNode }) {
  const { t } = useTranslation('marketing');

  return (
    <HelpBand id="get-the-app" title={t('help.install.title')} lead={t('help.install.intro')} media={media}>
      <MarketingInstallLinks placement="help" align="start" />
    </HelpBand>
  );
}
