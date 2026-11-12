'use client';

import React from 'react';
import MuiLink from '@mui/material/Link';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import { PageSection, Prose, ProseList } from '@/app/components/ui/page-shell';
import HelpPageShell from '../help-page-shell';
import HelpBreadcrumb from '../help-breadcrumb';
import HelpCallout from '../help-callout';
import HelpInstallSection from '../help-install-section';
import HelpSteps from '../help-steps';
import HelpSwipeDiagram from '../help-swipe-diagram';
import { HelpClip, HelpShots } from '../help-clip';
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
    >
      <PageSection id="player" title={t('help.climbs.player.title')} lead={t('help.climbs.player.lead')}>
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
        {/* MEDIA: screenshot of the preview top bar: "Preview · not on the wall", "Search results · 4 of 23" and the back chip. */}
        <HelpShots>
          <HelpClip
            name="preview-browsing"
            alt={t('help.climbs.player.clipAlt')}
            caption={t('help.climbs.player.clipCaption')}
          />
        </HelpShots>
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
      </PageSection>

      <PageSection id="climb-menu" title={t('help.climbs.menu.title')} lead={t('help.climbs.menu.lead')}>
        <HelpShots>
          <HelpClip
            name="long-press-climb-actions"
            alt={t('help.climbs.menu.clipAlt')}
            caption={t('help.climbs.menu.clipCaption')}
          />
        </HelpShots>
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
      </PageSection>

      <PageSection id="filters" title={t('help.climbs.filters.title')} lead={t('help.climbs.filters.lead')}>
        <HelpShots>
          <HelpClip
            name="grade-range-tap"
            alt={t('help.climbs.filters.gradeClipAlt')}
            caption={t('help.climbs.filters.gradeClipCaption')}
          />
        </HelpShots>
        <Prose>{t('help.climbs.filters.grade')}</Prose>
        <Prose>{t('help.climbs.filters.angle')}</Prose>
        <Prose>{t('help.climbs.filters.progress')}</Prose>
        <HelpShots>
          <HelpClip
            name="hold-filter-paint"
            alt={t('help.climbs.filters.holdClipAlt')}
            caption={t('help.climbs.filters.holdClipCaption')}
          />
        </HelpShots>
        <Prose>{t('help.climbs.filters.holdsIntro')}</Prose>
        <HelpSteps
          steps={[
            t('help.climbs.filters.holdStep1'),
            t('help.climbs.filters.holdStep2'),
            t('help.climbs.filters.holdStep3'),
          ]}
        />
        <Prose>{t('help.climbs.filters.holdNote')}</Prose>
        <HelpShots>
          <HelpClip
            name="zone-filter-drag"
            alt={t('help.climbs.filters.regionClipAlt')}
            caption={t('help.climbs.filters.regionClipCaption')}
          />
        </HelpShots>
        <Prose>{t('help.climbs.filters.region')}</Prose>
        <Prose>{t('help.climbs.filters.regionModes')}</Prose>
        <HelpShots>
          <HelpScreenshot
            shot="setters"
            alt={t('help.climbs.filters.shotAlt')}
            caption={t('help.climbs.filters.shotCaption')}
          />
        </HelpShots>
        <Prose>{t('help.climbs.filters.setters')}</Prose>
        <Prose>{t('help.climbs.filters.settersPicker')}</Prose>
        <Prose>{t('help.climbs.filters.count')}</Prose>
      </PageSection>

      <PageSection id="rows" title={t('help.climbs.rows.title')} lead={t('help.climbs.rows.lead')}>
        <HelpShots>
          <HelpClip
            name="swipe-row-queue-playlist"
            alt={t('help.climbs.rows.clipAlt')}
            caption={t('help.climbs.rows.clipCaption')}
          />
        </HelpShots>
        <Prose>{t('help.climbs.rows.p1')}</Prose>
        <Prose>{t('help.climbs.rows.p2')}</Prose>
      </PageSection>

      <PageSection id="playlists" title={t('help.climbs.playlists.title')} lead={t('help.climbs.playlists.lead')}>
        <HelpShots>
          <HelpScreenshot
            shot="discover"
            alt={t('help.climbs.playlists.discoverShotAlt')}
            caption={t('help.climbs.playlists.discoverShotCaption')}
          />
          <HelpScreenshot
            shot="playlist-detail"
            alt={t('help.climbs.playlists.detailShotAlt')}
            caption={t('help.climbs.playlists.detailShotCaption')}
          />
        </HelpShots>
        <HelpSteps
          steps={[t('help.climbs.playlists.step1'), t('help.climbs.playlists.step2'), t('help.climbs.playlists.step3')]}
        />
        <Prose>{t('help.climbs.playlists.p1')}</Prose>
        <Prose>{t('help.climbs.playlists.play')}</Prose>
        <HelpShots>
          <HelpClip
            name="remove-from-playlist"
            alt={t('help.climbs.playlists.removeClipAlt')}
            caption={t('help.climbs.playlists.removeClipCaption')}
          />
        </HelpShots>
        <Prose>{t('help.climbs.playlists.remove')}</Prose>
        <Prose>{t('help.climbs.playlists.reorder')}</Prose>
        <Prose>{t('help.climbs.playlists.forYou')}</Prose>
        <Prose>{t('help.climbs.playlists.forYouHow')}</Prose>
        <Prose>{t('help.climbs.playlists.tags')}</Prose>
        <Prose>
          <MuiLink component={LocaleLink} href="/playlists">
            {t('help.climbs.playlists.browse')}
          </MuiLink>
        </Prose>
      </PageSection>

      <HelpInstallSection />
    </HelpPageShell>
  );
}
