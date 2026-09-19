'use client';

import React from 'react';
import MuiLink from '@mui/material/Link';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import { PageShell, PageSection, Prose, ProseList } from '@/app/components/ui/page-shell';
import HelpBreadcrumb from '../help-breadcrumb';
import { HelpScreenshot, HelpShots } from '../help-screenshot';

/**
 * 329 climbers made a playlist in 90 days, and the questions that reach Discord
 * are about the parts that already work: taking a climb back out again, and the
 * playlist tags setting one climber had to tell another about. So removal gets
 * its own section rather than a clause.
 *
 * Every UI claim here was checked against packages/mobile: the Discover screen
 * (section order, the create plus, per-device smart-list pins), ClimbListRow
 * (swipe directions), InlinePlaylistPicker (checklist + board scoping),
 * PlaylistDetailView / use-playlist-activation (tap-to-queue, the Start
 * playlist? confirm, view-only taps in a shared session) and the backend
 * smart-playlists resolver (what feeds each curated list).
 */
export default function PlaylistsContent() {
  const { t } = useTranslation('marketing');

  return (
    <PageShell
      title={t('help.playlists.hero.title')}
      lead={t('help.playlists.hero.subtitle')}
      breadcrumb={<HelpBreadcrumb current={t('help.playlists.breadcrumb')} />}
    >
      <PageSection title={t('help.playlists.build.title')} lead={t('help.playlists.build.intro')}>
        <HelpShots>
          <HelpScreenshot
            shot="discover"
            alt={t('help.playlists.build.shotAlt')}
            caption={t('help.playlists.build.shotCaption')}
          />
          <HelpScreenshot
            shot="playlist-detail"
            alt={t('help.playlists.build.playlistShotAlt')}
            caption={t('help.playlists.build.playlistShotCaption')}
          />
        </HelpShots>
        <ProseList ordered>
          <li>{t('help.playlists.build.step1')}</li>
          <li>{t('help.playlists.build.step2')}</li>
          <li>{t('help.playlists.build.step3')}</li>
        </ProseList>
        <Prose>{t('help.playlists.build.p1')}</Prose>
        <Prose>{t('help.playlists.build.p2')}</Prose>
      </PageSection>

      <PageSection title={t('help.playlists.remove.title')} lead={t('help.playlists.remove.intro')}>
        <Prose>{t('help.playlists.remove.p1')}</Prose>
        <Prose>{t('help.playlists.remove.p2')}</Prose>
        <Prose>{t('help.playlists.remove.p3')}</Prose>
      </PageSection>

      <PageSection title={t('help.playlists.queue.title')} lead={t('help.playlists.queue.intro')}>
        <Prose>{t('help.playlists.queue.p1')}</Prose>
        <Prose>
          {t('help.playlists.queue.p2')}{' '}
          <MuiLink component={LocaleLink} href="/help/sessions">
            {t('help.playlists.queue.sessionsLink')}
          </MuiLink>
        </Prose>
      </PageSection>

      <PageSection title={t('help.playlists.smart.title')} lead={t('help.playlists.smart.intro')}>
        <ProseList>
          <li>{t('help.playlists.smart.crowdFavorites')}</li>
          <li>{t('help.playlists.smart.hiddenGems')}</li>
          <li>{t('help.playlists.smart.atYourLevel')}</li>
          <li>{t('help.playlists.smart.fresh')}</li>
        </ProseList>
        <ProseList>
          <li>{t('help.playlists.smart.fiveStars')}</li>
          <li>{t('help.playlists.smart.mostRepeated')}</li>
          <li>{t('help.playlists.smart.projects')}</li>
          <li>{t('help.playlists.smart.likedClimbs')}</li>
        </ProseList>
        <Prose>{t('help.playlists.smart.p1')}</Prose>
        <Prose>{t('help.playlists.smart.p2')}</Prose>
        <Prose>{t('help.playlists.smart.p3')}</Prose>
      </PageSection>

      <PageSection title={t('help.playlists.tags.title')} lead={t('help.playlists.tags.intro')}>
        <Prose>{t('help.playlists.tags.p1')}</Prose>
        <Prose>{t('help.playlists.tags.p2')}</Prose>
      </PageSection>

      <PageSection title={t('help.playlists.next.title')}>
        <ProseList>
          <li>
            <MuiLink component={LocaleLink} href="/help/climb-actions">
              {t('help.playlists.next.climbActions')}
            </MuiLink>
          </li>
          <li>
            <MuiLink component={LocaleLink} href="/playlists">
              {t('help.playlists.next.browse')}
            </MuiLink>
          </li>
          <li>
            <MuiLink component={LocaleLink} href="/help">
              {t('help.playlists.next.hub')}
            </MuiLink>
          </li>
        </ProseList>
      </PageSection>
    </PageShell>
  );
}
