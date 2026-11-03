'use client';

import React from 'react';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import { Prose, ProseList } from '@/app/components/ui/page-shell';
import HelpPageShell from '../help-page-shell';
import HelpBand from '../help-band';
import HelpBreadcrumb from '../help-breadcrumb';
import HelpInstallSection from '../help-install-section';
import { HelpScreenshot } from '../help-screenshot';

/**
 * 773 climbers have started a session and only 373 have ever joined one, so the
 * join half gets as much room as the start half. The wall sections answer the
 * Discord thread about four or five people in one session: the app already
 * keeps a crew's browsing off the wall, and nobody knew.
 *
 * Every label quoted in the copy is checked against the mobile catalogs
 * (session.json, feed.json, settings.json). A session is only ever created from
 * the Record tab; the Home rail and the board sheet only navigate there.
 * `#queue` is an alias of `#wall`; the driving rules live on
 * `/help/board-and-bluetooth#driving` and are linked, not repeated.
 */
export default function SessionsContent() {
  const { t } = useTranslation('marketing');

  return (
    <HelpPageShell
      title={t('help.crew.hero.title')}
      lead={t('help.crew.hero.subtitle')}
      breadcrumb={<HelpBreadcrumb current={t('help.crew.breadcrumb')} />}
      jumpLabel={t('help.nav.jump')}
      jumpLinks={[
        { id: 'start', label: t('help.crew.start.title') },
        { id: 'join', label: t('help.crew.join.title') },
        { id: 'wall', label: t('help.crew.wall.title') },
        { id: 'browsing', label: t('help.crew.browsing.title') },
        { id: 'history', label: t('help.crew.history.title') },
      ]}
    >
      <HelpBand
        id="start"
        title={t('help.crew.start.title')}
        lead={t('help.crew.start.lead')}
        media={
          <HelpScreenshot
            shot="session-detail"
            alt={t('help.crew.start.shotAlt')}
            caption={t('help.crew.start.shotCaption')}
          />
        }
      >
        <ProseList ordered>
          <li>{t('help.crew.start.step1')}</li>
          <li>{t('help.crew.start.step2')}</li>
          <li>{t('help.crew.start.step3')}</li>
        </ProseList>
      </HelpBand>

      <HelpBand
        id="join"
        flip
        title={t('help.crew.join.title')}
        lead={t('help.crew.join.lead')}
        media={
          <HelpScreenshot
            shot="live-sessions"
            alt={t('help.crew.start.liveShotAlt')}
            caption={t('help.crew.start.liveShotCaption')}
          />
        }
      >
        <ProseList>
          <li>{t('help.crew.join.way1')}</li>
          <li>{t('help.crew.join.way2')}</li>
          <li>{t('help.crew.join.way3')}</li>
        </ProseList>
        <Prose>{t('help.crew.join.p1')}</Prose>
      </HelpBand>

      <Box component="span" id="queue" />
      <HelpBand id="wall" title={t('help.crew.wall.title')} lead={t('help.crew.wall.lead')}>
        <Prose>{t('help.crew.wall.p1')}</Prose>
        <Prose>{t('help.crew.wall.busy')}</Prose>
        <Prose>{t('help.crew.wall.queue')}</Prose>
      </HelpBand>

      <HelpBand id="browsing" title={t('help.crew.browsing.title')} lead={t('help.crew.browsing.lead')}>
        <Prose>{t('help.crew.browsing.p1')}</Prose>
        <Prose>
          <MuiLink component={LocaleLink} href="/help/board-and-bluetooth#driving">
            {t('help.crew.browsing.drivingLink')}
          </MuiLink>
        </Prose>
      </HelpBand>

      <HelpBand id="history" title={t('help.crew.history.title')} lead={t('help.crew.history.lead')}>
        <Prose>{t('help.crew.history.p1')}</Prose>
      </HelpBand>

      <HelpInstallSection />

      <HelpBand title={t('help.crew.next.title')}>
        <ProseList>
          <li>
            <MuiLink component={LocaleLink} href="/help/finding-climbs#playlists">
              {t('help.crew.next.playlists')}
            </MuiLink>
          </li>
          <li>
            <MuiLink component={LocaleLink} href="/help">
              {t('help.crew.next.hub')}
            </MuiLink>
          </li>
        </ProseList>
      </HelpBand>
    </HelpPageShell>
  );
}
