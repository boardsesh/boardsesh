'use client';

import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import MarketingInstallLinks from '@/app/components/marketing/marketing-install-links';
import { brandCtaSx } from '@/app/components/ui/brand-cta';
import { PageShell, PageSection, PageCard, Prose, ProseList } from '@/app/components/ui/page-shell';
import styles from './help.module.css';

const DISCORD_INVITE_URL = 'https://discord.gg/YXA8GsXfQK';
const GITHUB_ISSUES_URL = 'https://github.com/boardsesh/boardsesh/issues';
// Anchor for /help#climb-counts, linked from docs/kilter-sync.md.
const CLIMB_COUNTS_SECTION_ID = 'climb-counts';

const CTA_SX = brandCtaSx();

/** One card per guide page. Card copy lives under `help.guides.<key>`. */
const TOPICS = [
  { key: 'playlists', href: '/help/playlists' },
  { key: 'climbActions', href: '/help/climb-actions' },
  { key: 'sessions', href: '/help/sessions' },
  { key: 'findingClimbs', href: '/help/finding-climbs' },
  { key: 'logbook', href: '/help/logbook' },
  { key: 'betaVideos', href: '/help/beta-videos' },
  { key: 'bluetooth', href: '/help/board-and-bluetooth' },
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
 * drawer → Settings → the More screen → Connected apps → Board Accounts, where
 * the Tension card says "Link" and the Kilter card says "Sign in to Kilter".
 */
export default function HelpContent() {
  const { t } = useTranslation('marketing');

  return (
    <PageShell title={t('help.hero.title')} lead={t('help.hero.subtitle')} width="wide">
      <Box className={styles.layout}>
        <Box component="nav" aria-label={t('help.topics.label')} className={styles.topics}>
          <MuiLink href="#guides">{t('help.topics.guides')}</MuiLink>
          <MuiLink href="#using-boardsesh">{t('help.topics.using')}</MuiLink>
          <MuiLink href="#bring-your-logbook">{t('help.topics.logbook')}</MuiLink>
          <MuiLink href="#climb-counts">{t('help.topics.counts')}</MuiLink>
          <MuiLink href="#get-help">{t('help.topics.ask')}</MuiLink>
        </Box>
        <Box className={styles.content}>
          <PageSection id="guides" title={t('help.guides.title')} lead={t('help.guides.intro')}>
            <Box component="ul" className={styles.cards}>
              {TOPICS.map((topic) => (
                <PageCard component="li" key={topic.key} padding="lg" radius="xl" className={styles.card}>
                  <Typography component="h3" className={styles.cardTitle}>
                    <MuiLink component={LocaleLink} href={topic.href} underline="hover">
                      {t(`help.guides.${topic.key}.title`)}
                    </MuiLink>
                  </Typography>
                  <Typography component="p" className={styles.cardBody}>
                    {t(`help.guides.${topic.key}.body`)}
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
                <MarketingInstallLinks />
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
    </PageShell>
  );
}
