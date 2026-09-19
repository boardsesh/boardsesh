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

/** Each topic is a whole page now, so the hub carries the path, not the answer. */
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
 * The front-door help page.
 *
 * It documented nine interactive features once, with screenshots from an e2e run
 * that drove those very surfaces; climbing moved to the app and both went away,
 * leaving an honest split of what this site does and what the app does.
 *
 * The guides below are the other half coming back. The adoption numbers said the
 * gap was never "what is Boardsesh" — it was "how do I take a climb back out of
 * a playlist", so each card is a page that answers one of those.
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
              {/* This section's own list includes "light up holds over Bluetooth",
                  which the browser cannot do — Safari has no Web Bluetooth. It
                  used to hand the reader the web app anyway. */}
              <Box sx={{ mt: 2 }}>
                <MarketingInstallLinks />
              </Box>
            </PageSection>
          </Box>
          <PageSection id="bring-your-logbook" title={t('help.aurora.title')} lead={t('help.aurora.intro')}>
            <ProseList>
              <li>{t('help.aurora.item1')}</li>
              <li>{t('help.aurora.item2')}</li>
              {/* Which way sync runs was the most repeated question in the Discord —
                  four separate people read the "pending sync" label as a queued push
                  back to Kilter. It is not, and never was. */}
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

          {/* Three equal bullets sent a stuck climber to GitHub issues and
              developer docs as peers of the place questions actually get
              answered. Discord is the answer; the other two are for people who
              already know which one they want. */}
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
