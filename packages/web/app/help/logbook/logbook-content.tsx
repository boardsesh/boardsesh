'use client';

import React from 'react';
import MuiLink from '@mui/material/Link';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import { PageShell, PageSection, Prose, ProseList } from '@/app/components/ui/page-shell';
import HelpBreadcrumb from '../help-breadcrumb';
import { HelpScreenshot, HelpShots } from '../help-screenshot';

/**
 * 91 climbers have ever edited a logbook entry, and the feature request that
 * comes up on Discord — "sometimes I forget to rate a climb and can't go back"
 * — describes something that has shipped for a long time. The edit section is
 * the reason this page exists; everything else is context around it.
 */
export default function LogbookContent() {
  const { t } = useTranslation('marketing');

  return (
    <PageShell
      title={t('help.logbook.hero.title')}
      lead={t('help.logbook.hero.subtitle')}
      breadcrumb={<HelpBreadcrumb current={t('help.logbook.breadcrumb')} />}
    >
      <PageSection title={t('help.logbook.log.title')} lead={t('help.logbook.log.intro')}>
        <HelpShots>
          <HelpScreenshot
            shot="board-view"
            alt={t('help.logbook.log.shotAlt')}
            caption={t('help.logbook.log.shotCaption')}
          />
          <HelpScreenshot
            shot="logbook"
            alt={t('help.logbook.edit.shotAlt')}
            caption={t('help.logbook.edit.shotCaption')}
          />
        </HelpShots>
        <Prose>{t('help.logbook.log.p1')}</Prose>
        <Prose>{t('help.logbook.log.p2')}</Prose>
      </PageSection>

      <PageSection title={t('help.logbook.edit.title')} lead={t('help.logbook.edit.intro')}>
        <Prose>{t('help.logbook.edit.p1')}</Prose>
        <ProseList>
          <li>{t('help.logbook.edit.field1')}</li>
          <li>{t('help.logbook.edit.field2')}</li>
          <li>{t('help.logbook.edit.field3')}</li>
        </ProseList>
        <Prose>{t('help.logbook.edit.p2')}</Prose>
        <Prose>{t('help.logbook.edit.p3')}</Prose>
      </PageSection>

      <PageSection title={t('help.logbook.delete.title')} lead={t('help.logbook.delete.intro')}>
        <Prose>{t('help.logbook.delete.p1')}</Prose>
        <Prose>{t('help.logbook.delete.p2')}</Prose>
      </PageSection>

      <PageSection title={t('help.logbook.repeats.title')} lead={t('help.logbook.repeats.intro')}>
        <Prose>{t('help.logbook.repeats.p1')}</Prose>
        <Prose>{t('help.logbook.repeats.p2')}</Prose>
      </PageSection>

      <PageSection title={t('help.logbook.find.title')} lead={t('help.logbook.find.intro')}>
        <Prose>{t('help.logbook.find.p1')}</Prose>
        <Prose>
          {t('help.logbook.find.p2')}{' '}
          <MuiLink component={LocaleLink} href="/aurora-migration">
            {t('help.logbook.find.auroraLink')}
          </MuiLink>
        </Prose>
      </PageSection>

      <PageSection title={t('help.logbook.next.title')}>
        <ProseList>
          <li>
            <MuiLink component={LocaleLink} href="/help/climb-actions">
              {t('help.logbook.next.climbActions')}
            </MuiLink>
          </li>
          <li>
            <MuiLink component={LocaleLink} href="/help/beta-videos">
              {t('help.logbook.next.betaVideos')}
            </MuiLink>
          </li>
          <li>
            <MuiLink component={LocaleLink} href="/help/finding-climbs">
              {t('help.logbook.next.findingClimbs')}
            </MuiLink>
          </li>
          <li>
            <MuiLink component={LocaleLink} href="/help">
              {t('help.logbook.next.hub')}
            </MuiLink>
          </li>
        </ProseList>
      </PageSection>
    </PageShell>
  );
}
