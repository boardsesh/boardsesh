'use client';

import React from 'react';
import MuiLink from '@mui/material/Link';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import { PageSection, Prose, ProseList } from '@/app/components/ui/page-shell';
import HelpPageShell from '../help-page-shell';
import HelpBreadcrumb from '../help-breadcrumb';
import HelpInstallSection from '../help-install-section';
import { HelpClip, HelpShots } from '../help-clip';
import { HelpScreenshot } from '../help-screenshot';

/**
 * The least-found interaction in the app. `Climb Actions Opened` has fired for
 * 837 people since it started recording on 2026-07-21, against 3,936 who opened
 * a climb in the same window — about one in five. Most of what Discord asks for
 * is already a row in this menu. The loudest request of all, browsing a shared
 * session without lighting the wall for everyone, is now what a plain tap does:
 * since 2.7 (#7188) a tap opens a preview.
 *
 * The action list and every gate (signed in, own climb, moderation flag, Aurora
 * boards, Replay from here on a History row) come from
 * packages/mobile/src/components/climb-actions/climb-menu-items.ts; the list
 * menu's groups from LIST_GROUPS in ClimbActionsMenu.tsx. The menu offers no
 * Preview row: a tap on the row already opens one. The preview chrome comes from
 * play-drawer/wall-state.ts (resolveBrowseCaption), track-label-text.ts and
 * WallStatePill.tsx (the wordless back chip); the bar at the bottom from
 * queue-control/use-bar-climb.ts (the last climb opened).
 */
export default function ClimbActionsContent() {
  const { t } = useTranslation('marketing');

  return (
    <HelpPageShell
      title={t('help.climbActions.hero.title')}
      lead={t('help.climbActions.hero.subtitle')}
      breadcrumb={<HelpBreadcrumb current={t('help.climbActions.breadcrumb')} />}
    >
      <PageSection title={t('help.climbActions.open.title')}>
        <HelpShots>
          <HelpClip
            name="long-press-climb-actions"
            alt={t('help.climbActions.open.clipAlt')}
            caption={t('help.climbActions.open.clipCaption')}
          />
          <HelpScreenshot
            shot="climb-actions"
            alt={t('help.climbActions.open.shotAlt')}
            caption={t('help.climbActions.open.shotCaption')}
          />
        </HelpShots>
        <Prose>{t('help.climbActions.open.p1')}</Prose>
        <Prose>{t('help.climbActions.open.p2')}</Prose>
      </PageSection>

      <PageSection title={t('help.climbActions.preview.title')} lead={t('help.climbActions.preview.intro')}>
        <HelpShots>
          <HelpClip
            name="preview-browsing"
            alt={t('help.climbActions.preview.clipAlt')}
            caption={t('help.climbActions.preview.clipCaption')}
          />
          <HelpScreenshot
            shot="preview"
            alt={t('help.climbActions.preview.shotAlt')}
            caption={t('help.climbActions.preview.shotCaption')}
          />
        </HelpShots>
        <Prose>{t('help.climbActions.preview.p1')}</Prose>
        <Prose>
          {t('help.climbActions.preview.p2')}{' '}
          <MuiLink component={LocaleLink} href="/help/sessions">
            {t('help.climbActions.preview.sessionsLink')}
          </MuiLink>
        </Prose>
        <Prose>{t('help.climbActions.preview.p3')}</Prose>
        <Prose>
          <MuiLink component={LocaleLink} href="/help/board-and-bluetooth#driving">
            {t('help.climbActions.preview.drivingLink')}
          </MuiLink>
        </Prose>
      </PageSection>

      <PageSection title={t('help.climbActions.quick.title')}>
        <ProseList>
          <li>{t('help.climbActions.quick.tick')}</li>
          <li>{t('help.climbActions.quick.playlist')}</li>
          <li>{t('help.climbActions.quick.share')}</li>
        </ProseList>
        <Prose>{t('help.climbActions.quick.p1')}</Prose>
      </PageSection>

      <PageSection title={t('help.climbActions.rest.title')}>
        <ProseList ordered>
          <li>{t('help.climbActions.rest.queue')}</li>
          <li>{t('help.climbActions.rest.replay')}</li>
          <li>{t('help.climbActions.rest.favorite')}</li>
          <li>{t('help.climbActions.rest.editEntry')}</li>
          <li>{t('help.climbActions.rest.betaVideo')}</li>
          <li>{t('help.climbActions.rest.edit')}</li>
          <li>{t('help.climbActions.rest.remix')}</li>
          <li>{t('help.climbActions.rest.openInAurora')}</li>
          <li>{t('help.climbActions.rest.report')}</li>
        </ProseList>
      </PageSection>

      <HelpInstallSection />

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
    </HelpPageShell>
  );
}
