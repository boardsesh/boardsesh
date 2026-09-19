'use client';

import React from 'react';
import MuiLink from '@mui/material/Link';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import { PageShell, PageSection, Prose, ProseList } from '@/app/components/ui/page-shell';
import HelpBreadcrumb from '../help-breadcrumb';
import { HelpScreenshot, HelpShots } from '../help-screenshot';

/**
 * Three filters that ship and almost nobody has found: 147 climbers have ever
 * used the hold filter and 62 the board region. Two Discord threads asked for
 * setter following while it was already in the Filters sheet. So this page is
 * written as directions, not as a feature list.
 */
export default function FindingClimbsContent() {
  const { t } = useTranslation('marketing');

  return (
    <PageShell
      title={t('help.findingClimbs.hero.title')}
      lead={t('help.findingClimbs.hero.subtitle')}
      breadcrumb={<HelpBreadcrumb current={t('help.findingClimbs.breadcrumb')} />}
    >
      <PageSection title={t('help.findingClimbs.start.title')} lead={t('help.findingClimbs.start.intro')}>
        <Prose>{t('help.findingClimbs.start.p1')}</Prose>
        <Prose>{t('help.findingClimbs.start.p2')}</Prose>
        <Prose>{t('help.findingClimbs.start.p3')}</Prose>
      </PageSection>

      <PageSection title={t('help.findingClimbs.holds.title')} lead={t('help.findingClimbs.holds.intro')}>
        <HelpShots>
          <HelpScreenshot
            shot="holds-filter"
            alt={t('help.findingClimbs.holds.shotAlt')}
            caption={t('help.findingClimbs.holds.shotCaption')}
          />
          <HelpScreenshot
            shot="zone-filter"
            alt={t('help.findingClimbs.zone.shotAlt')}
            caption={t('help.findingClimbs.zone.shotCaption')}
          />
        </HelpShots>
        <Prose>{t('help.findingClimbs.holds.p1')}</Prose>
        <ProseList ordered>
          <li>{t('help.findingClimbs.holds.step1')}</li>
          <li>{t('help.findingClimbs.holds.step2')}</li>
          <li>{t('help.findingClimbs.holds.step3')}</li>
        </ProseList>
        <Prose>{t('help.findingClimbs.holds.p2')}</Prose>
        <Prose>{t('help.findingClimbs.holds.p3')}</Prose>
      </PageSection>

      <PageSection title={t('help.findingClimbs.zone.title')} lead={t('help.findingClimbs.zone.intro')}>
        <Prose>{t('help.findingClimbs.zone.p1')}</Prose>
        <Prose>{t('help.findingClimbs.zone.p2')}</Prose>
      </PageSection>

      <PageSection title={t('help.findingClimbs.setters.title')} lead={t('help.findingClimbs.setters.intro')}>
        <HelpShots>
          <HelpScreenshot
            shot="setters"
            alt={t('help.findingClimbs.setters.shotAlt')}
            caption={t('help.findingClimbs.setters.shotCaption')}
          />
        </HelpShots>
        <Prose>{t('help.findingClimbs.setters.p1')}</Prose>
        <Prose>{t('help.findingClimbs.setters.p2')}</Prose>
      </PageSection>

      <PageSection title={t('help.findingClimbs.rows.title')} lead={t('help.findingClimbs.rows.intro')}>
        <Prose>{t('help.findingClimbs.rows.p1')}</Prose>
        <Prose>{t('help.findingClimbs.rows.p3')}</Prose>
        <Prose>
          {t('help.findingClimbs.rows.p2')}{' '}
          <MuiLink component={LocaleLink} href="/help/climb-actions">
            {t('help.findingClimbs.rows.actionsLink')}
          </MuiLink>
        </Prose>
      </PageSection>

      <PageSection title={t('help.findingClimbs.keep.title')} lead={t('help.findingClimbs.keep.intro')}>
        <Prose>{t('help.findingClimbs.keep.p1')}</Prose>
        <Prose>{t('help.findingClimbs.keep.p2')}</Prose>
      </PageSection>

      <PageSection title={t('help.findingClimbs.next.title')}>
        <ProseList>
          <li>
            <MuiLink component={LocaleLink} href="/help/climb-actions">
              {t('help.findingClimbs.next.climbActions')}
            </MuiLink>
          </li>
          <li>
            <MuiLink component={LocaleLink} href="/help/playlists">
              {t('help.findingClimbs.next.playlists')}
            </MuiLink>
          </li>
          <li>
            <MuiLink component={LocaleLink} href="/help">
              {t('help.findingClimbs.next.hub')}
            </MuiLink>
          </li>
        </ProseList>
      </PageSection>
    </PageShell>
  );
}
