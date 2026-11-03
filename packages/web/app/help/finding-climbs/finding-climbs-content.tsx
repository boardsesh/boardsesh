'use client';

import React from 'react';
import MuiLink from '@mui/material/Link';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import { Prose, ProseList } from '@/app/components/ui/page-shell';
import HelpPageShell from '../help-page-shell';
import HelpBand from '../help-band';
import HelpBreadcrumb from '../help-breadcrumb';
import HelpCallout from '../help-callout';
import HelpInstallSection from '../help-install-section';
import HelpSteps from '../help-steps';
import HelpSwipeDiagram from '../help-swipe-diagram';
import { HelpClip } from '../help-clip';
import { HelpScreenshot } from '../help-screenshot';

/**
 * Everything you do with a list of climbs: swipe through it, press and hold a
 * row, filter it, save climbs to playlists. Merges the old climb-actions and
 * playlists pages (301s in next.config.mjs). The ids are link targets: the
 * redirects land on #climb-menu and #playlists.
 *
 * Where a swipe goes comes from the 2.7 interaction model: a tap previews, swipes
 * walk the list named at the top, and the wall only changes on Put on board or
 * while driving. Queue internals stay out on purpose.
 */
export default function FindingClimbsContent() {
  const { t } = useTranslation('marketing');

  return (
    <HelpPageShell
      title={t('help.climbs.hero.title')}
      lead={t('help.climbs.hero.subtitle')}
      breadcrumb={<HelpBreadcrumb current={t('help.climbs.breadcrumb')} />}
      jumpLabel={t('help.nav.jump')}
      jumpLinks={[
        { id: 'player', label: t('help.climbs.player.title') },
        { id: 'climb-menu', label: t('help.climbs.menu.title') },
        { id: 'filters', label: t('help.climbs.filters.title') },
        { id: 'rows', label: t('help.climbs.rows.title') },
        { id: 'playlists', label: t('help.climbs.playlists.title') },
      ]}
    >
      {/* The diagram gets the band's full width: its flow needs ~700px to run sideways. */}
      <HelpBand id="player" wide title={t('help.climbs.player.title')} lead={t('help.climbs.player.lead')}>
        <HelpSwipeDiagram
          labels={{
            description: t('help.climbs.diagram.description'),
            listCurrent: t('help.climbs.diagram.listCurrent', { list: t('help.climbs.diagram.listName') }),
            listCaption: t('help.climbs.diagram.listCaption'),
            listPrevious: t('help.climbs.diagram.listPrevious'),
            listNext: t('help.climbs.diagram.listNext'),
            wallCaption: t('help.climbs.diagram.wallCaption'),
            preview: t('help.climbs.diagram.preview'),
            putOnBoard: t('help.climbs.diagram.putOnBoard'),
            onWall: t('help.climbs.diagram.onWall'),
            upNext: t('help.climbs.diagram.upNext'),
            endCard: t('help.climbs.diagram.endCard'),
            thenFrom: t('help.climbs.diagram.thenFrom', { list: t('help.climbs.diagram.listName') }),
          }}
        />
      </HelpBand>

      <HelpBand
        continues
        media={
          <HelpClip
            name="preview-browsing"
            alt={t('help.climbs.player.clipAlt')}
            caption={t('help.climbs.player.clipCaption')}
          />
        }
      >
        <Prose>{t('help.climbs.player.p1')}</Prose>
        <Prose>{t('help.climbs.player.p2')}</Prose>
        <Prose>{t('help.climbs.player.p3')}</Prose>
        <Prose>{t('help.climbs.player.p4')}</Prose>
        <HelpCallout>
          {t('help.climbs.player.callout')}{' '}
          <MuiLink component={LocaleLink} href="/help/board-and-bluetooth#driving">
            {t('help.climbs.player.drivingLink')}
          </MuiLink>
        </HelpCallout>
      </HelpBand>

      <HelpBand
        id="climb-menu"
        flip
        title={t('help.climbs.menu.title')}
        lead={t('help.climbs.menu.lead')}
        media={
          <HelpClip
            name="long-press-climb-actions"
            alt={t('help.climbs.menu.clipAlt')}
            caption={t('help.climbs.menu.clipCaption')}
          />
        }
      >
        <Prose>{t('help.climbs.menu.p1')}</Prose>
        <ProseList>
          <li>{t('help.climbs.menu.playNext')}</li>
          <li>{t('help.climbs.menu.favorite')}</li>
          <li>{t('help.climbs.menu.remix')}</li>
          <li>{t('help.climbs.menu.edit')}</li>
          <li>{t('help.climbs.menu.others')}</li>
        </ProseList>
        <Prose>
          {t('help.climbs.menu.p2')}{' '}
          <MuiLink component={LocaleLink} href="/help/logbook#beta-videos">
            {t('help.climbs.menu.betaLink')}
          </MuiLink>
        </Prose>
      </HelpBand>

      <HelpBand
        id="filters"
        title={t('help.climbs.filters.title')}
        lead={t('help.climbs.filters.lead')}
        media={
          <HelpClip
            name="grade-range-tap"
            alt={t('help.climbs.filters.gradeClipAlt')}
            caption={t('help.climbs.filters.gradeClipCaption')}
          />
        }
      >
        <Prose>{t('help.climbs.filters.grade')}</Prose>
        <Prose>{t('help.climbs.filters.angle')}</Prose>
        <Prose>{t('help.climbs.filters.progress')}</Prose>
      </HelpBand>

      <HelpBand
        continues
        flip
        media={
          <HelpClip
            name="hold-filter-paint"
            alt={t('help.climbs.filters.holdClipAlt')}
            caption={t('help.climbs.filters.holdClipCaption')}
          />
        }
      >
        <Prose>{t('help.climbs.filters.holdsIntro')}</Prose>
        <HelpSteps
          steps={[
            t('help.climbs.filters.holdStep1'),
            t('help.climbs.filters.holdStep2'),
            t('help.climbs.filters.holdStep3'),
          ]}
        />
        <Prose>{t('help.climbs.filters.holdNote')}</Prose>
      </HelpBand>

      <HelpBand
        continues
        media={
          <HelpClip
            name="zone-filter-drag"
            alt={t('help.climbs.filters.regionClipAlt')}
            caption={t('help.climbs.filters.regionClipCaption')}
          />
        }
      >
        <Prose>{t('help.climbs.filters.region')}</Prose>
        <Prose>{t('help.climbs.filters.regionModes')}</Prose>
      </HelpBand>

      <HelpBand
        continues
        flip
        secondaryMedia
        media={
          <HelpScreenshot
            shot="setters"
            alt={t('help.climbs.filters.shotAlt')}
            caption={t('help.climbs.filters.shotCaption')}
          />
        }
      >
        <Prose>{t('help.climbs.filters.setters')}</Prose>
        <Prose>{t('help.climbs.filters.settersPicker')}</Prose>
        <Prose>{t('help.climbs.filters.count')}</Prose>
      </HelpBand>

      <HelpBand
        id="rows"
        title={t('help.climbs.rows.title')}
        lead={t('help.climbs.rows.lead')}
        media={
          <HelpClip
            name="swipe-row-queue-playlist"
            alt={t('help.climbs.rows.clipAlt')}
            caption={t('help.climbs.rows.clipCaption')}
          />
        }
      >
        <Prose>{t('help.climbs.rows.p1')}</Prose>
        <Prose>{t('help.climbs.rows.p2')}</Prose>
      </HelpBand>

      <HelpBand
        id="playlists"
        flip
        title={t('help.climbs.playlists.title')}
        lead={t('help.climbs.playlists.lead')}
        media={
          <HelpScreenshot
            shot="discover"
            alt={t('help.climbs.playlists.discoverShotAlt')}
            caption={t('help.climbs.playlists.discoverShotCaption')}
          />
        }
      >
        <HelpSteps
          steps={[t('help.climbs.playlists.step1'), t('help.climbs.playlists.step2'), t('help.climbs.playlists.step3')]}
        />
        <Prose>{t('help.climbs.playlists.p1')}</Prose>
        <Prose>{t('help.climbs.playlists.play')}</Prose>
      </HelpBand>

      <HelpBand
        continues
        media={
          <HelpClip
            name="remove-from-playlist"
            alt={t('help.climbs.playlists.removeClipAlt')}
            caption={t('help.climbs.playlists.removeClipCaption')}
          />
        }
      >
        <Prose>{t('help.climbs.playlists.remove')}</Prose>
        <Prose>{t('help.climbs.playlists.reorder')}</Prose>
      </HelpBand>

      <HelpBand
        continues
        flip
        secondaryMedia
        media={
          <HelpScreenshot
            shot="playlist-detail"
            alt={t('help.climbs.playlists.detailShotAlt')}
            caption={t('help.climbs.playlists.detailShotCaption')}
          />
        }
      >
        <Prose>{t('help.climbs.playlists.forYou')}</Prose>
        <Prose>{t('help.climbs.playlists.forYouHow')}</Prose>
        <Prose>{t('help.climbs.playlists.tags')}</Prose>
        <Prose>
          <MuiLink component={LocaleLink} href="/playlists">
            {t('help.climbs.playlists.browse')}
          </MuiLink>
        </Prose>
      </HelpBand>

      <HelpInstallSection />
    </HelpPageShell>
  );
}
