'use client';

import React, { useMemo } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import MarketingInstallLinks from '@/app/components/marketing/marketing-install-links';
import { brandCtaSx } from '@/app/components/ui/brand-cta';
import ArrowForwardOutlined from '@mui/icons-material/ArrowForwardOutlined';
import BluetoothOutlined from '@mui/icons-material/BluetoothOutlined';
import FilterListOutlined from '@mui/icons-material/FilterListOutlined';
import GroupsOutlined from '@mui/icons-material/GroupsOutlined';
import MenuBookOutlined from '@mui/icons-material/MenuBookOutlined';
import OndemandVideoOutlined from '@mui/icons-material/OndemandVideoOutlined';
import PhotoCameraOutlined from '@mui/icons-material/PhotoCameraOutlined';
import PlaylistPlayOutlined from '@mui/icons-material/PlaylistPlayOutlined';
import TouchAppOutlined from '@mui/icons-material/TouchAppOutlined';
import { PageSection, PageCard, Prose, ProseList } from '@/app/components/ui/page-shell';
import HelpPageShell from './help-page-shell';
import HelpTopicsNav from './help-topics-nav';
import styles from './help.module.css';

const DISCORD_INVITE_URL = 'https://discord.gg/YXA8GsXfQK';
const GITHUB_ISSUES_URL = 'https://github.com/boardsesh/boardsesh/issues';
// Anchor for /help#climb-counts, linked from docs/kilter-sync.md.
const CLIMB_COUNTS_SECTION_ID = 'climb-counts';

const CTA_SX = brandCtaSx();

/**
 * One card per guide page. Card copy lives under `help.guides.<key>`. The icon
 * names what the page is about at a glance; it is decorative, the title is the
 * card's only accessible name.
 */
const TOPICS = [
  { key: 'playlists', href: '/help/playlists', Icon: PlaylistPlayOutlined },
  { key: 'climbActions', href: '/help/climb-actions', Icon: TouchAppOutlined },
  { key: 'sessions', href: '/help/sessions', Icon: GroupsOutlined },
  { key: 'findingClimbs', href: '/help/finding-climbs', Icon: FilterListOutlined },
  { key: 'logbook', href: '/help/logbook', Icon: MenuBookOutlined },
  { key: 'betaVideos', href: '/help/beta-videos', Icon: OndemandVideoOutlined },
  { key: 'bluetooth', href: '/help/board-and-bluetooth', Icon: BluetoothOutlined },
  { key: 'sprayWalls', href: '/help/spray-walls', Icon: PhotoCameraOutlined },
] as const;

/**
 * /help, the front door of the help site.
 *
 * Five things a reader should be able to settle in a few seconds: which guide
 * they want (the cards), what this site does vs the app, how to link a Kilter or
 * Tension account, why Kilter's app shows more climbs, and where to ask. The
 * section ids are stable: `climb-counts` is linked from docs/kilter-sync.md.
 *
 * The Aurora linking steps are checked against the mobile app: avatar → user
 * drawer → Settings → Connected apps → Board accounts, where
 * the Tension card says "Link" and the Kilter card says "Sign in to Kilter".
 */
export default function HelpContent() {
  const { t } = useTranslation('marketing');
  // Memoised: HelpTopicsNav rebuilds its IntersectionObserver whenever this
  // array's identity changes, so it must only change with the language.
  const sectionTopics = useMemo(
    () => [
      { id: 'guides', label: t('help.topics.guides') },
      { id: 'using-boardsesh', label: t('help.topics.using') },
      { id: 'bring-your-logbook', label: t('help.topics.logbook') },
      { id: CLIMB_COUNTS_SECTION_ID, label: t('help.topics.counts') },
      { id: 'get-help', label: t('help.topics.ask') },
    ],
    [t],
  );

  return (
    <HelpPageShell title={t('help.hero.title')} lead={t('help.hero.subtitle')} width="wide">
      <Box className={styles.layout}>
        <HelpTopicsNav label={t('help.topics.label')} topics={sectionTopics} />
        <Box className={styles.content}>
          <PageSection id="guides" title={t('help.guides.title')} lead={t('help.guides.intro')}>
            {/* The whole card is the link target: the title's link stretches over
                the card with ::after, so there is one link per card, named by its
                title alone. */}
            <Box component="ul" className={styles.cards}>
              {TOPICS.map(({ key, href, Icon }) => (
                <PageCard component="li" key={key} padding="md" radius="xl" className={styles.card}>
                  <Box component="span" aria-hidden="true" className={styles.cardIcon}>
                    <Icon fontSize="inherit" />
                  </Box>
                  <Typography component="h3" className={styles.cardTitle}>
                    <MuiLink component={LocaleLink} href={href} underline="none" className={styles.cardLink}>
                      {t(`help.guides.${key}.title`)}
                    </MuiLink>
                    <ArrowForwardOutlined aria-hidden="true" className={styles.cardArrow} />
                  </Typography>
                  <Typography component="p" className={styles.cardBody}>
                    {t(`help.guides.${key}.body`)}
                  </Typography>
                </PageCard>
              ))}
            </Box>
          </PageSection>

          <Box id="using-boardsesh" className={styles.using}>
            <PageSection title={t('help.web.title')} lead={t('help.web.intro')}>
              <ProseList>
                <li>{t('help.web.item1')}</li>
                <li>{t('help.web.item2')}</li>
                <li>{t('help.web.item3')}</li>
                <li>{t('help.web.item4')}</li>
              </ProseList>
              <Prose>
                <MuiLink component={LocaleLink} href="/playlists">
                  {t('help.web.playlistsLink')}
                </MuiLink>
                {' · '}
                <MuiLink component={LocaleLink} href="/about">
                  {t('help.web.aboutLink')}
                </MuiLink>
              </Prose>
            </PageSection>

            <PageSection title={t('help.app.title')} lead={t('help.app.intro')}>
              <ProseList>
                <li>{t('help.app.item1')}</li>
                <li>{t('help.app.item2')}</li>
                <li>{t('help.app.item3')}</li>
                <li>{t('help.app.item4')}</li>
              </ProseList>
              {/* Store links, not the web app: Bluetooth only works from the native app. */}
              <Box sx={{ mt: 2 }}>
                <MarketingInstallLinks placement="help" />
              </Box>
            </PageSection>
          </Box>
          <PageSection id="bring-your-logbook" title={t('help.aurora.title')} lead={t('help.aurora.intro')}>
            <ProseList>
              <li>{t('help.aurora.item1')}</li>
              <li>{t('help.aurora.item2')}</li>
              {/* Sync direction. The app's "pending sync" label gets read as a push
                  back to Kilter; there is none (kilter-sync push-back is stubbed). */}
              <li>{t('help.aurora.item3')}</li>
            </ProseList>
            <Prose>
              <MuiLink component={LocaleLink} href="/aurora-migration">
                {t('help.aurora.link')}
              </MuiLink>
            </Prose>
          </PageSection>

          <PageSection
            id={CLIMB_COUNTS_SECTION_ID}
            title={t('help.climbCounts.title')}
            lead={t('help.climbCounts.intro')}
          >
            <ProseList>
              <li>{t('help.climbCounts.item1')}</li>
              <li>{t('help.climbCounts.item2')}</li>
              <li>{t('help.climbCounts.item3')}</li>
            </ProseList>
          </PageSection>

          {/* Discord is the primary CTA; GitHub and the API docs are secondary links. */}
          <PageSection id="get-help" title={t('help.ask.title')} lead={t('help.ask.intro')}>
            <Box sx={{ mt: 1 }}>
              <Button
                variant="contained"
                sx={CTA_SX}
                href={DISCORD_INVITE_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t('help.ask.discord')}
              </Button>
            </Box>
            <Prose>
              {t('help.ask.bugLead')}{' '}
              <MuiLink href={GITHUB_ISSUES_URL} target="_blank" rel="noopener noreferrer">
                {t('help.ask.github')}
              </MuiLink>
            </Prose>
            <Prose>
              {t('help.ask.devLead')}{' '}
              <MuiLink component={LocaleLink} href="/docs">
                {t('help.ask.docs')}
              </MuiLink>
            </Prose>
          </PageSection>
        </Box>
      </Box>
    </HelpPageShell>
  );
}
