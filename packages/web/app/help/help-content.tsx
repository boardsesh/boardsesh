'use client';

import React from 'react';
import Image from 'next/image';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import { brandCtaOutlinedSx, brandCtaSx } from '@/app/components/ui/brand-cta';
import { resolveStaticAssetUrl } from '@/app/lib/static-asset-url';
import { helpScreenshot, type HelpShot } from '@/app/lib/help-screenshots';
import HelpPageShell from './help-page-shell';
import HelpBand from './help-band';
import HelpInstallSection from './help-install-section';
import { HelpScreenshot } from './help-screenshot';
import styles from './help.module.css';

const DISCORD_INVITE_URL = 'https://discord.gg/YXA8GsXfQK';
const GITHUB_ISSUES_URL = 'https://github.com/boardsesh/boardsesh/issues';
// Anchor for /help#climb-counts, linked from docs/kilter-sync.md.
const CLIMB_COUNTS_SECTION_ID = 'climb-counts';

const CTA_SX = brandCtaSx();
const OUTLINED_CTA_SX = brandCtaOutlinedSx();

/**
 * One tile per guide. Copy lives under `help.hub.guides.<key>`. Each tile shows
 * that guide's own screen rising from its bottom edge; `peekY` slides the
 * capture up inside the window so the useful part shows (the lit board art for
 * the board guide, the hold rings for Spraywalls). The capture is decorative:
 * the title is the tile's only accessible name.
 *
 * The first two tiles are the most-read guides, so they get the wide slots.
 */
const GUIDES: ReadonlyArray<{ key: string; href: string; shot: HelpShot; peekY: string; wide: boolean }> = [
  { key: 'start', href: '/help/board-and-bluetooth', shot: 'drive-timed', peekY: '-30%', wide: true },
  { key: 'browse', href: '/help/finding-climbs', shot: 'discover', peekY: '-6%', wide: true },
  { key: 'crew', href: '/help/sessions', shot: 'live-sessions', peekY: '-6%', wide: false },
  { key: 'logbook', href: '/help/logbook', shot: 'logbook', peekY: '-6%', wide: false },
  { key: 'spray', href: '/help/spray-walls', shot: 'spray-editor-select', peekY: '-20%', wide: false },
];

/**
 * /help, the front door of the help site.
 *
 * Five things a reader should be able to settle in a few seconds: which guide
 * they want (the tiles), what this site does vs the app, how to link a Kilter or
 * Tension account, why Kilter's app shows more climbs, and where to ask. The
 * section ids are stable: `climb-counts` is linked from docs/kilter-sync.md.
 */
export default function HelpContent() {
  const { t } = useTranslation('marketing');

  return (
    <HelpPageShell
      title={t('help.hub.hero.title')}
      lead={t('help.hub.hero.subtitle')}
      jumpLabel={t('help.nav.jump')}
      jumpLinks={[
        { id: 'guides', label: t('help.hub.topics.guides') },
        { id: 'get-the-app', label: t('help.hub.topics.app') },
        { id: 'bring-your-logbook', label: t('help.hub.topics.logbook') },
        { id: CLIMB_COUNTS_SECTION_ID, label: t('help.hub.topics.counts') },
        { id: 'get-help', label: t('help.hub.topics.ask') },
      ]}
    >
      <HelpBand id="guides" wide title={t('help.hub.guides.title')} lead={t('help.hub.guides.lead')}>
        {/* The title's link stretches over the tile with ::after, so each tile
            is one link named by its title alone. */}
        <Box component="ul" className={styles.tiles}>
          {GUIDES.map(({ key, href, shot, peekY, wide }) => {
            const capture = helpScreenshot(shot);
            return (
              <Box component="li" key={key} className={wide ? `${styles.tile} ${styles.tileWide}` : styles.tile}>
                <Box className={styles.tileText}>
                  <Typography component="h3" className={styles.tileTitle}>
                    <MuiLink component={LocaleLink} href={href} underline="none" className={styles.tileLink}>
                      {t(`help.hub.guides.${key}.title`)}
                    </MuiLink>
                  </Typography>
                  <Typography component="p" className={styles.tileBody}>
                    {t(`help.hub.guides.${key}.body`)}
                  </Typography>
                  <Box component="span" aria-hidden="true" className={styles.tileGo}>
                    {t('help.hub.guides.read')}
                  </Box>
                </Box>
                <Box className={styles.peek} sx={{ '--peek-y': peekY }}>
                  <Image
                    src={resolveStaticAssetUrl(capture.src)}
                    alt=""
                    width={capture.width}
                    height={capture.height}
                    sizes="250px"
                    className={styles.peekImage}
                  />
                </Box>
              </Box>
            );
          })}
        </Box>
      </HelpBand>

      <HelpInstallSection media={<HelpScreenshot shot="climb-actions" alt="" cropped />} />

      <HelpBand
        id="bring-your-logbook"
        flip
        title={t('help.hub.bring.title')}
        lead={t('help.hub.bring.lead')}
        media={<HelpScreenshot shot="logbook" alt="" cropped />}
      >
        <Button variant="outlined" component={LocaleLink} href="/help/logbook#bring-your-logbook" sx={OUTLINED_CTA_SX}>
          {t('help.hub.bring.link')}
        </Button>
      </HelpBand>

      <HelpBand id={CLIMB_COUNTS_SECTION_ID} wide title={t('help.hub.counts.title')} lead={t('help.hub.counts.lead')}>
        <Box className={styles.counts}>
          <Box className={styles.count}>
            <Typography component="p" className={styles.countNumber}>
              {t('help.hub.counts.boardseshCount')}
            </Typography>
            <Typography component="p" className={styles.countLabel}>
              {t('help.hub.counts.boardseshLabel')}
            </Typography>
          </Box>
          <Box className={styles.count}>
            <Typography component="p" className={`${styles.countNumber} ${styles.countNumberMuted}`}>
              {t('help.hub.counts.kilterCount')}
            </Typography>
            <Typography component="p" className={styles.countLabel}>
              {t('help.hub.counts.kilterLabel')}
            </Typography>
          </Box>
        </Box>
      </HelpBand>

      {/* Discord is the primary CTA; GitHub and the API docs are secondary links. */}
      <HelpBand id="get-help" wide title={t('help.hub.ask.title')} lead={t('help.hub.ask.lead')}>
        <Box component="ul" className={styles.askCards}>
          <Box component="li" className={styles.askCard}>
            <Typography component="h3" className={styles.askTitle}>
              {t('help.hub.ask.discordTitle')}
            </Typography>
            <Typography component="p" className={styles.askBody}>
              {t('help.hub.ask.discordBody')}
            </Typography>
            <Button variant="contained" sx={CTA_SX} href={DISCORD_INVITE_URL} target="_blank" rel="noopener noreferrer">
              {t('help.hub.ask.discord')}
            </Button>
          </Box>
          <Box component="li" className={styles.askCard}>
            <Typography component="h3" className={styles.askTitle}>
              {t('help.hub.ask.bugLead')}
            </Typography>
            <Typography component="p" className={styles.askBody}>
              {t('help.hub.ask.bugBody')}
            </Typography>
            <MuiLink href={GITHUB_ISSUES_URL} target="_blank" rel="noopener noreferrer" className={styles.askLink}>
              {t('help.hub.ask.github')}
            </MuiLink>
          </Box>
          <Box component="li" className={styles.askCard}>
            <Typography component="h3" className={styles.askTitle}>
              {t('help.hub.ask.devLead')}
            </Typography>
            <Typography component="p" className={styles.askBody}>
              {t('help.hub.ask.devBody')}
            </Typography>
            <MuiLink component={LocaleLink} href="/docs" className={styles.askLink}>
              {t('help.hub.ask.docs')}
            </MuiLink>
          </Box>
        </Box>
      </HelpBand>
    </HelpPageShell>
  );
}
