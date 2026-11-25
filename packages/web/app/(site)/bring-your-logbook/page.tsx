import BoardAppGuideLink from '@/app/components/marketing/board-app-guide-link';
import React from 'react';
import { importPathChosen } from '@boardsesh/analytics';
import { WebsiteJourneyButton, WebsiteJourneyLink } from '@/app/components/marketing/website-journey-link';
import MuiLink from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import LocaleLink from '@/app/components/i18n/locale-link';
import StoreInstallButtons from '@/app/components/marketing/store-install-buttons';
import { PageSection, PageShell, Prose } from '@/app/components/ui/page-shell';
import { buildAppHandoffUrl } from '@/app/lib/app-handoff';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { getStoreButtonLabels } from '@/app/lib/store-button-labels.server';
import HelpSteps from '@/app/help/help-steps';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('aurora');
  return createPageMetadata({
    title: t('metadata.migration.title'),
    description: t('metadata.migration.description'),
    path: '/bring-your-logbook',
    locale,
  });
}

export default async function BringYourLogbookPage() {
  const [{ t, locale }, storeLabels] = await Promise.all([getServerTranslation('aurora'), getStoreButtonLabels()]);

  return (
    <PageShell title={t('migration.title')} lead={t('migration.lead')}>
      <PageSection title={t('migration.account.title')}>
        <HelpSteps steps={[t('migration.account.step1'), t('migration.account.step2'), t('migration.account.step3')]} />
        <Prose>{t('migration.account.sync')}</Prose>
        <Stack direction="row">
          <WebsiteJourneyButton
            event={importPathChosen('account-link')}
            href="#get-the-app"
            variant="contained"
            sx={{ display: { xs: 'inline-flex', sm: 'none' } }}
          >
            {t('migration.install')}
          </WebsiteJourneyButton>
          <WebsiteJourneyButton
            event={importPathChosen('account-link')}
            href={buildAppHandoffUrl('/auth/login')}
            variant="contained"
            sx={{ display: { xs: 'none', sm: 'inline-flex' } }}
          >
            {t('migration.account.signIn')}
          </WebsiteJourneyButton>
        </Stack>
      </PageSection>

      <PageSection id="old-kilter-app" title={t('migration.legacy.title')}>
        <HelpSteps
          steps={[
            <>
              <strong>{t('migration.legacy.request')}</strong>
              <Prose>{t('migration.legacy.export')}</Prose>
              <WebsiteJourneyLink event={importPathChosen('aurora-export')} href="mailto:support@auroraclimbing.com">
                {t('migration.legacy.support')}
              </WebsiteJourneyLink>
            </>,
            t('migration.legacy.signIn'),
            <>
              <strong>{t('migration.legacy.upload')}</strong>
              <Prose>{t('migration.legacy.uploadInstructions')}</Prose>
            </>,
          ]}
        />
      </PageSection>

      <PageSection title={t('migration.history.title')}>
        <Prose>{t('migration.history.body')}</Prose>
        <Prose>
          <MuiLink href="https://www.climbing.com/news/why-the-kilter-board-app-suddenly-disappeared/">
            {t('migration.history.article')}
          </MuiLink>
        </Prose>
        <Prose>
          <MuiLink component={LocaleLink} href="/help/logbook" locale={locale}>
            {t('migration.logbookHelp')}
          </MuiLink>
        </Prose>
      </PageSection>

      <PageSection id="get-the-app" title={t('migration.install')}>
        <StoreInstallButtons placement="bring-your-logbook" align="start" labels={storeLabels} />
        <Stack sx={{ alignItems: 'start', mt: 2 }}>
          <BoardAppGuideLink board="kilter" />
          <BoardAppGuideLink board="tension" />
        </Stack>
      </PageSection>
    </PageShell>
  );
}
