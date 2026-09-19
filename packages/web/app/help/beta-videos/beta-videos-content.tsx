'use client';

import React from 'react';
import MuiLink from '@mui/material/Link';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import { PageShell, PageSection, Prose, ProseList } from '@/app/components/ui/page-shell';
import HelpBreadcrumb from '../help-breadcrumb';

/**
 * /help/beta-videos, in the order a climber meets the feature: where the Beta
 * Videos section is on a climb, how to attach a post they already made (share
 * sheet → "Attach your beta"), how to film new beta from a climb ("Share your
 * beta", three steps), and where their own collect on the profile.
 *
 * Every UI label here is checked against packages/mobile: `share-beta.tsx`,
 * `AddBetaVideoSheet.tsx`, `DeferredSections.tsx`, `ProfileBetaShelf.tsx` and
 * the `session` / `climbs` / `you` catalogs. Only Instagram and TikTok links are
 * accepted (`isBetaVideoUrl`), attaching has no confirm step, and there is no
 * mutation to remove an attached video, so the copy says so.
 */
export default function BetaVideosContent() {
  const { t } = useTranslation('marketing');

  return (
    <PageShell
      title={t('help.betaVideos.hero.title')}
      lead={t('help.betaVideos.hero.subtitle')}
      breadcrumb={<HelpBreadcrumb current={t('help.betaVideos.breadcrumb')} />}
    >
      <PageSection title={t('help.betaVideos.find.title')} lead={t('help.betaVideos.find.intro')}>
        <Prose>{t('help.betaVideos.find.p1')}</Prose>
        <Prose>{t('help.betaVideos.find.p2')}</Prose>
        <Prose>
          {t('help.betaVideos.find.p3')}{' '}
          <MuiLink component={LocaleLink} href="/help/finding-climbs">
            {t('help.betaVideos.find.filtersLink')}
          </MuiLink>
        </Prose>
      </PageSection>

      <PageSection title={t('help.betaVideos.share.title')} lead={t('help.betaVideos.share.intro')}>
        <Prose>{t('help.betaVideos.share.p1')}</Prose>
        <Prose>{t('help.betaVideos.share.p2')}</Prose>
        <Prose>{t('help.betaVideos.share.p3')}</Prose>
      </PageSection>

      <PageSection title={t('help.betaVideos.add.title')} lead={t('help.betaVideos.add.intro')}>
        <Prose>{t('help.betaVideos.add.p1')}</Prose>
        <Prose>{t('help.betaVideos.add.p2')}</Prose>
        <Prose>{t('help.betaVideos.add.p3')}</Prose>
      </PageSection>

      <PageSection title={t('help.betaVideos.shelf.title')} lead={t('help.betaVideos.shelf.intro')}>
        <Prose>{t('help.betaVideos.shelf.p1')}</Prose>
        <Prose>{t('help.betaVideos.shelf.p2')}</Prose>
      </PageSection>

      <PageSection title={t('help.betaVideos.next.title')}>
        <ProseList>
          <li>
            <MuiLink component={LocaleLink} href="/help/climb-actions">
              {t('help.betaVideos.next.climbActions')}
            </MuiLink>
          </li>
          <li>
            <MuiLink component={LocaleLink} href="/help/logbook">
              {t('help.betaVideos.next.logbook')}
            </MuiLink>
          </li>
          <li>
            <MuiLink component={LocaleLink} href="/help">
              {t('help.betaVideos.next.hub')}
            </MuiLink>
          </li>
        </ProseList>
      </PageSection>
    </PageShell>
  );
}
