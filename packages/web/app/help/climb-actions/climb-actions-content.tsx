'use client';

import React from 'react';
import MuiLink from '@mui/material/Link';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import { PageShell, PageSection, Prose, ProseList } from '@/app/components/ui/page-shell';
import HelpBreadcrumb from '../help-breadcrumb';
import { HelpScreenshot, HelpShots } from '../help-screenshot';

/**
 * The least-found interaction in the app. `Climb Actions Opened` has fired for
 * 837 people since it started recording on 2026-07-21, against 3,936 who opened
 * a climb in the same window — about one in five. Most of what Discord asks for
 * is already a row in this menu, and Preview answers the loudest request of all:
 * browsing a shared session without lighting the wall for everyone.
 */
export default function ClimbActionsContent() {
  const { t } = useTranslation('marketing');

  return (
    <PageShell
      title={t('help.climbActions.hero.title')}
      lead={t('help.climbActions.hero.subtitle')}
      breadcrumb={<HelpBreadcrumb current={t('help.climbActions.breadcrumb')} />}
    >
      <PageSection title={t('help.climbActions.open.title')} lead={t('help.climbActions.open.intro')}>
        <HelpShots>
          <HelpScreenshot
            shot="climb-actions"
            alt={t('help.climbActions.open.shotAlt')}
            caption={t('help.climbActions.open.shotCaption')}
          />
          <HelpScreenshot
            shot="preview"
            alt={t('help.climbActions.open.previewShotAlt')}
            caption={t('help.climbActions.open.previewShotCaption')}
          />
        </HelpShots>
        <Prose>{t('help.climbActions.open.p1')}</Prose>
        <Prose>{t('help.climbActions.open.p2')}</Prose>
      </PageSection>

      <PageSection title={t('help.climbActions.preview.title')} lead={t('help.climbActions.preview.intro')}>
        <Prose>{t('help.climbActions.preview.p1')}</Prose>
        <Prose>{t('help.climbActions.preview.p2')}</Prose>
        <Prose>{t('help.climbActions.preview.p3')}</Prose>
        <Prose>
          {t('help.climbActions.preview.p4')}{' '}
          <MuiLink component={LocaleLink} href="/help/sessions">
            {t('help.climbActions.preview.sessionsLink')}
          </MuiLink>
        </Prose>
      </PageSection>

      <PageSection title={t('help.climbActions.quick.title')} lead={t('help.climbActions.quick.intro')}>
        <Prose>{t('help.climbActions.quick.p1')}</Prose>
        <Prose>{t('help.climbActions.quick.p2')}</Prose>
      </PageSection>

      <PageSection title={t('help.climbActions.rest.title')} lead={t('help.climbActions.rest.intro')}>
        <ProseList>
          <li>{t('help.climbActions.rest.queue')}</li>
          <li>{t('help.climbActions.rest.favorite')}</li>
          <li>{t('help.climbActions.rest.editEntry')}</li>
          <li>{t('help.climbActions.rest.betaVideo')}</li>
          <li>{t('help.climbActions.rest.edit')}</li>
        </ProseList>
        <ProseList>
          <li>{t('help.climbActions.rest.remix')}</li>
          <li>{t('help.climbActions.rest.openInAurora')}</li>
          <li>{t('help.climbActions.rest.report')}</li>
        </ProseList>
      </PageSection>

      <PageSection title={t('help.climbActions.next.title')}>
        <ProseList>
          <li>
            <MuiLink component={LocaleLink} href="/help/logbook">
              {t('help.climbActions.next.logbook')}
            </MuiLink>
          </li>
          <li>
            <MuiLink component={LocaleLink} href="/help/playlists">
              {t('help.climbActions.next.playlists')}
            </MuiLink>
          </li>
          <li>
            <MuiLink component={LocaleLink} href="/help/beta-videos">
              {t('help.climbActions.next.betaVideos')}
            </MuiLink>
          </li>
          <li>
            <MuiLink component={LocaleLink} href="/help">
              {t('help.climbActions.next.hub')}
            </MuiLink>
          </li>
        </ProseList>
      </PageSection>
    </PageShell>
  );
}
