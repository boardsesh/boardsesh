import React from 'react';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import LocaleLink from '@/app/components/i18n/locale-link';
import { PageShell, PageSection, PageCard, Prose } from '@/app/components/ui/page-shell';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { brandCtaSx } from '@/app/components/ui/brand-cta';
import { gymClaimPathClicked, partnerContactClicked } from '@boardsesh/analytics';
import { WebsiteJourneyButton, WebsiteJourneyLink } from '@/app/components/marketing/website-journey-link';
import { localeHref } from '@/app/lib/i18n/locale-href';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('website');
  return createPageMetadata({ title: t('forGymsTitle'), description: t('forGymsLead'), path: '/for-gyms', locale });
}

export default async function ForGymsPage() {
  const { t, locale } = await getServerTranslation('website');
  return (
    <PageShell title={t('forGymsTitle')} lead={t('forGymsLead')}>
      <WebsiteJourneyButton
        href={localeHref('/gyms?claim=1', locale)}
        event={gymClaimPathClicked('for-gyms')}
        variant="contained"
        sx={brandCtaSx()}
      >
        {t('claimGym')}
      </WebsiteJourneyButton>
      <Box sx={{ display: 'grid', gap: 3, my: 4 }}>
        <PageSection title={t('membersTitle')} lead={t('membersBody')}>
          <MuiLink component={LocaleLink} href="/boards">
            {t('compatibility')}
          </MuiLink>
        </PageSection>
        <PageSection title={t('staffTitle')} lead={t('staffBody')} />
        <PageSection title={t('kioskTitle')} lead={t('kioskBody')} />
        <PageSection title={t('privacyTitle')} lead={t('privacyBody')}>
          <MuiLink component={LocaleLink} href="/privacy">
            {t('privacyTitle')}
          </MuiLink>
        </PageSection>
        <PageCard>
          <PageSection id="partners" title={t('partnerTitle')} lead={t('partnerBody')}>
            <WebsiteJourneyLink
              href="mailto:support@boardsesh.com?subject=Boardsesh%20wall%20partnership"
              event={partnerContactClicked('partner', 'for-gyms')}
            >
              {t('contact')}
            </WebsiteJourneyLink>
          </PageSection>
        </PageCard>
        <Prose>{t('sprayLead')}</Prose>
        <MuiLink component={LocaleLink} href="/spraywalls">
          {t('sprayRoute')}
        </MuiLink>
      </Box>
    </PageShell>
  );
}
