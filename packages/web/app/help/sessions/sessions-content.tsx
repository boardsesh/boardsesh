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
 *
 * Every label quoted in the copy is checked against the mobile catalogs
 * (session.json, feed.json, settings.json). A session is only ever created from
 * the Record tab; the Home rail and the board sheet only navigate there.
 */
export default function SessionsContent() {
  const { t } = useTranslation('marketing');

  return (
    <PageShell
      title={t('help.sessions.hero.title')}
      lead={t('help.sessions.hero.subtitle')}
      breadcrumb={<HelpBreadcrumb current={t('help.sessions.breadcrumb')} />}
    >
      <PageSection id="start" title={t('help.sessions.start.title')} lead={t('help.sessions.start.intro')}>
        <HelpShots>
          <HelpScreenshot
            shot="session-detail"
            alt={t('help.sessions.start.shotAlt')}
            caption={t('help.sessions.start.shotCaption')}
          />
          <HelpScreenshot
            shot="live-sessions"
            alt={t('help.sessions.start.liveShotAlt')}
            caption={t('help.sessions.start.liveShotCaption')}
          />
        </HelpShots>
        <ProseList ordered>
          <li>{t('help.sessions.start.step1')}</li>
          <li>{t('help.sessions.start.step2')}</li>
          <li>{t('help.sessions.start.step3')}</li>
        </ProseList>
        <Prose>{t('help.sessions.start.p1')}</Prose>
        <Prose>{t('help.sessions.start.p2')}</Prose>
      </PageSection>

      <PageSection id="join" title={t('help.sessions.join.title')} lead={t('help.sessions.join.intro')}>
        <ProseList>
          <li>{t('help.sessions.join.way1')}</li>
          <li>{t('help.sessions.join.way2')}</li>
          <li>{t('help.sessions.join.way3')}</li>
        </ProseList>
        <Prose>{t('help.sessions.join.p1')}</Prose>
      </PageSection>

      <PageSection id="queue" title={t('help.sessions.queue.title')} lead={t('help.sessions.queue.intro')}>
        <Prose>{t('help.sessions.queue.p1')}</Prose>
        <Prose>{t('help.sessions.queue.p2')}</Prose>
      </PageSection>

      <PageSection id="wall" title={t('help.sessions.wall.title')} lead={t('help.sessions.wall.intro')}>
        <Prose>{t('help.sessions.wall.p1')}</Prose>
        <Prose>{t('help.sessions.wall.p2')}</Prose>
        <Prose>
          {t('help.sessions.wall.p3')}{' '}
          <MuiLink component={LocaleLink} href="/help/board-and-bluetooth">
            {t('help.sessions.wall.bluetoothLink')}
          </MuiLink>
        </Prose>
      </PageSection>

      <PageSection id="browsing" title={t('help.sessions.crowd.title')} lead={t('help.sessions.crowd.intro')}>
        <Prose>{t('help.sessions.crowd.p1')}</Prose>
        <Prose>{t('help.sessions.crowd.p2')}</Prose>
        <Prose>
          {t('help.sessions.crowd.p3')}{' '}
          <MuiLink component={LocaleLink} href="/help/climb-actions">
            {t('help.sessions.crowd.previewLink')}
          </MuiLink>
        </Prose>
      </PageSection>

      <PageSection id="history" title={t('help.sessions.history.title')} lead={t('help.sessions.history.intro')}>
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
