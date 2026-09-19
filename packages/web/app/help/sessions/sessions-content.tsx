'use client';

import React from 'react';
import MuiLink from '@mui/material/Link';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import { PageShell, PageSection, Prose, ProseList } from '@/app/components/ui/page-shell';
import HelpBreadcrumb from '../help-breadcrumb';
import { HelpScreenshot, HelpShots } from '../help-screenshot';

/**
 * 773 climbers have started a session and only 373 have ever joined one, so the
 * join half gets as much room as the start half. The wall sections answer the
 * Discord thread about four or five people in one session: the app already
 * keeps a crew's browsing off the wall, and nobody knew.
 */
export default function SessionsContent() {
  const { t } = useTranslation('marketing');

  return (
    <PageShell
      title={t('help.sessions.hero.title')}
      lead={t('help.sessions.hero.subtitle')}
      breadcrumb={<HelpBreadcrumb current={t('help.sessions.breadcrumb')} />}
    >
      <PageSection title={t('help.sessions.start.title')} lead={t('help.sessions.start.intro')}>
        <HelpShots>
          <HelpScreenshot
            shot="live-sessions"
            alt={t('help.sessions.join.shotAlt')}
            caption={t('help.sessions.join.shotCaption')}
          />
          <HelpScreenshot
            shot="session-detail"
            alt={t('help.sessions.start.shotAlt')}
            caption={t('help.sessions.start.shotCaption')}
          />
        </HelpShots>
        <Prose>{t('help.sessions.start.p1')}</Prose>
        <Prose>{t('help.sessions.start.p2')}</Prose>
      </PageSection>

      <PageSection title={t('help.sessions.join.title')} lead={t('help.sessions.join.intro')}>
        <Prose>{t('help.sessions.join.p1')}</Prose>
        <ProseList>
          <li>{t('help.sessions.join.way1')}</li>
          <li>{t('help.sessions.join.way2')}</li>
          <li>{t('help.sessions.join.way3')}</li>
        </ProseList>
      </PageSection>

      <PageSection title={t('help.sessions.queue.title')} lead={t('help.sessions.queue.intro')}>
        <Prose>{t('help.sessions.queue.p1')}</Prose>
        <Prose>{t('help.sessions.queue.p2')}</Prose>
      </PageSection>

      <PageSection title={t('help.sessions.wall.title')} lead={t('help.sessions.wall.intro')}>
        <Prose>{t('help.sessions.wall.p1')}</Prose>
        <Prose>{t('help.sessions.wall.p2')}</Prose>
        <Prose>
          {t('help.sessions.wall.p3')}{' '}
          <MuiLink component={LocaleLink} href="/help/board-and-bluetooth">
            {t('help.sessions.wall.bluetoothLink')}
          </MuiLink>
        </Prose>
      </PageSection>

      <PageSection title={t('help.sessions.crowd.title')} lead={t('help.sessions.crowd.intro')}>
        <Prose>{t('help.sessions.crowd.p1')}</Prose>
        <Prose>{t('help.sessions.crowd.p3')}</Prose>
        <Prose>
          {t('help.sessions.crowd.p2')}{' '}
          <MuiLink component={LocaleLink} href="/help/climb-actions">
            {t('help.sessions.crowd.previewLink')}
          </MuiLink>
        </Prose>
      </PageSection>

      <PageSection title={t('help.sessions.history.title')} lead={t('help.sessions.history.intro')}>
        <Prose>{t('help.sessions.history.p1')}</Prose>
        <Prose>{t('help.sessions.history.p2')}</Prose>
      </PageSection>

      <PageSection title={t('help.sessions.next.title')}>
        <ProseList>
          <li>
            <MuiLink component={LocaleLink} href="/help/playlists">
              {t('help.sessions.next.playlists')}
            </MuiLink>
          </li>
          <li>
            <MuiLink component={LocaleLink} href="/help">
              {t('help.sessions.next.hub')}
            </MuiLink>
          </li>
        </ProseList>
      </PageSection>
    </PageShell>
  );
}
