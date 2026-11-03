'use client';

import React, { useMemo } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import { brandCtaSx } from '@/app/components/ui/brand-cta';
import ArrowForwardOutlined from '@mui/icons-material/ArrowForwardOutlined';
import BluetoothOutlined from '@mui/icons-material/BluetoothOutlined';
import FilterListOutlined from '@mui/icons-material/FilterListOutlined';
import GroupsOutlined from '@mui/icons-material/GroupsOutlined';
import MenuBookOutlined from '@mui/icons-material/MenuBookOutlined';
import PhotoCameraOutlined from '@mui/icons-material/PhotoCameraOutlined';
import { PageSection, PageCard, Prose, ProseList } from '@/app/components/ui/page-shell';
import HelpPageShell from './help-page-shell';
import HelpInstallSection from './help-install-section';
import HelpTopicsNav from './help-topics-nav';
import styles from './help.module.css';

const DISCORD_INVITE_URL = 'https://discord.gg/YXA8GsXfQK';
const GITHUB_ISSUES_URL = 'https://github.com/boardsesh/boardsesh/issues';
// Anchor for /help#climb-counts, linked from docs/kilter-sync.md.
const CLIMB_COUNTS_SECTION_ID = 'climb-counts';

const CTA_SX = brandCtaSx();

/**
 * One card per guide page. Card copy lives under `help.hub.guides.<key>`. The icon
 * names what the page is about at a glance; it is decorative, the title is the
 * card's only accessible name.
 */
const TOPICS = [
  { key: 'start', href: '/help/board-and-bluetooth', Icon: BluetoothOutlined },
  { key: 'browse', href: '/help/finding-climbs', Icon: FilterListOutlined },
  { key: 'crew', href: '/help/sessions', Icon: GroupsOutlined },
  { key: 'logbook', href: '/help/logbook', Icon: MenuBookOutlined },
  { key: 'spray', href: '/help/spray-walls', Icon: PhotoCameraOutlined },
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
      { id: 'guides', label: t('help.hub.topics.guides') },
      { id: 'get-the-app', label: t('help.hub.topics.app') },
      { id: 'bring-your-logbook', label: t('help.hub.topics.logbook') },
      { id: CLIMB_COUNTS_SECTION_ID, label: t('help.hub.topics.counts') },
      { id: 'get-help', label: t('help.hub.topics.ask') },
    ],
    [t],
  );

  return (
    <HelpPageShell title={t('help.hub.hero.title')} lead={t('help.hub.hero.subtitle')} width="wide">
      <Box className={styles.layout}>
        <HelpTopicsNav label={t('help.hub.topics.label')} topics={sectionTopics} />
        <Box className={styles.content}>
          <PageSection id="guides" title={t('help.hub.guides.title')} lead={t('help.hub.guides.lead')}>
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
                      {t(`help.hub.guides.${key}.title`)}
                    </MuiLink>
                    <ArrowForwardOutlined aria-hidden="true" className={styles.cardArrow} />
                  </Typography>
                  <Typography component="p" className={styles.cardBody}>
                    {t(`help.hub.guides.${key}.body`)}
                  </Typography>
                </PageCard>
              ))}
            </Box>
          </PageSection>

          <HelpInstallSection />

          <PageSection id="bring-your-logbook" title={t('help.hub.bring.title')} lead={t('help.hub.bring.lead')}>
            <Prose>
              <MuiLink component={LocaleLink} href="/help/logbook#bring-your-logbook">
                {t('help.hub.bring.link')}
              </MuiLink>
            </Prose>
          </PageSection>

          <PageSection id={CLIMB_COUNTS_SECTION_ID} title={t('help.hub.counts.title')} lead={t('help.hub.counts.lead')}>
            <ProseList>
              <li>{t('help.hub.counts.item1')}</li>
              <li>{t('help.hub.counts.item2')}</li>
            </ProseList>
          </PageSection>

          {/* Discord is the primary CTA; GitHub and the API docs are secondary links. */}
          <PageSection id="get-help" title={t('help.hub.ask.title')} lead={t('help.hub.ask.lead')}>
            <Box sx={{ mt: 1 }}>
              <Button
                variant="contained"
                sx={CTA_SX}
                href={DISCORD_INVITE_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t('help.hub.ask.discord')}
              </Button>
            </Box>
            <Prose>
              {t('help.hub.ask.bugLead')}{' '}
              <MuiLink href={GITHUB_ISSUES_URL} target="_blank" rel="noopener noreferrer">
                {t('help.hub.ask.github')}
              </MuiLink>
            </Prose>
            <Prose>
              {t('help.hub.ask.devLead')}{' '}
              <MuiLink component={LocaleLink} href="/docs">
                {t('help.hub.ask.docs')}
              </MuiLink>
            </Prose>
          </PageSection>
        </Box>
      </Box>
    </HelpPageShell>
  );
}
