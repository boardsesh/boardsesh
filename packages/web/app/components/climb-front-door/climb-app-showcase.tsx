import type { BoardName } from '@/app/lib/types';
import BoardAppGuideLink from '@/app/components/marketing/board-app-guide-link';
import React, { Suspense } from 'react';
import Image from 'next/image';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import PlayArrowRounded from '@mui/icons-material/PlayArrowRounded';
import LocaleLink from '@/app/components/i18n/locale-link';
import { MarketingPreviewProvider } from '@/app/components/marketing/marketing-preview-provider';
import { MarketingScreenshot } from '@/app/components/marketing/marketing-screenshot';
import StoreInstallButtons from '@/app/components/marketing/store-install-buttons';
import { dedupeBetaLinks, type BetaLink } from '@/app/lib/beta-video-url';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { classifyMarketingBrowser } from '@/app/lib/marketing-platform';
import { resolveStaticAssetUrl } from '@/app/lib/static-asset-url';
import { getStoreButtonLabels } from '@/app/lib/store-button-labels.server';
import { themeTokens } from '@/app/theme/theme-config';
import BetaFanCard from './beta-fan-card';
import CommunityProofLine from './community-proof-line';
import { frontDoorSectionHeadingSx } from './front-door-heading-sx';
import { STICKY_INSTALL_HIDE_ATTRIBUTE } from './sticky-install-markers';
import styles from './climb-app-showcase.module.css';

type ClimbAppShowcaseProps = {
  /**
   * This climb's beta, as the page already loaded it for the beta section.
   * The "Instant beta" card shows up to three of its thumbnails; with none, a
   * plain play tile (`InstantBetaVisual` says why never other climbs' beta).
   */
  betaLinks: readonly BetaLink[];
  board?: BoardName;
};

/** How many of this climb's beta thumbnails the "Instant beta" card fans out. */
const MAX_FAN_CARDS = 3;

/**
 * What the screenshots render as before the browser has been asked which phone
 * it is: a user agent nobody sends. The page is stored at the edge for a day
 * with no user-agent split, so the first visitor's phone must not pick the
 * screenshots for everyone (`front-door-install.test.tsx` pins this). After
 * mount the provider reads the real device and swaps to its captures; every
 * phone sits in a box of fixed height, so the swap moves nothing.
 */
const SHARED_HTML_BROWSER = classifyMarketingBrowser('');

/** The homepage's "Every board. One app." poster, cropped to its three phones by CSS. */
const POSTER_PATH = '/images/home/showcase-hero-9x16.webp';
const POSTER_WIDTH = 1080;
const POSTER_HEIGHT = 1920;

/** The phone's width at each layout step, in step with `climb-app-showcase.module.css`. */
const PHONE_SIZES = '(min-width: 1100px) 212px, (min-width: 900px) 196px, 182px';
/** A card's width: the snap-scroller card below md, a third of the 1200px page from md. */
const POSTER_SIZES = '(min-width: 1200px) 390px, (min-width: 900px) 33vw, 286px';

// The band's heading is a step up from the page's other `<h2>`s: it opens the
// part of the page about the app rather than the climb.
const headingSx = {
  ...frontDoorSectionHeadingSx,
  mb: 1,
  fontSize: { xs: themeTokens.typography.fontSize['2xl'], md: themeTokens.typography.fontSize['3xl'] },
  lineHeight: 1.15,
  textWrap: 'balance' as const,
};

const leadSx = {
  margin: 0,
  color: 'var(--neutral-500)',
  fontSize: { xs: themeTokens.typography.fontSize.base, md: 17 },
};

const cardTitleSx = {
  margin: `0 0 ${themeTokens.spacing[2]}px`,
  color: 'var(--neutral-900)',
  fontFamily: 'var(--font-display), sans-serif',
  fontWeight: themeTokens.typography.fontWeight.semibold,
  fontSize: { xs: 19, md: 21 },
  lineHeight: themeTokens.typography.lineHeight.tight,
  letterSpacing: '-0.012em',
};

const cardBodySx = {
  margin: 0,
  maxWidth: '36ch',
  color: 'var(--neutral-500)',
  fontSize: { xs: themeTokens.typography.fontSize.sm, md: 15 },
  lineHeight: themeTokens.typography.lineHeight.normal,
};

// 44px tall, so it is a tap target and not a line of text.
const cardLinkSx = {
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 44,
  marginTop: `${themeTokens.spacing[1]}px`,
  fontWeight: themeTokens.typography.fontWeight.semibold,
  fontSize: 15,
};

type BenefitCardProps = {
  title: string;
  body: string;
  /** A link under the sentence, for the one card with somewhere to go. */
  action?: React.ReactNode;
  /** The picture, pinned to the bottom of the card. */
  children: React.ReactNode;
  visualClassName?: string;
  wide?: boolean;
};

function BenefitCard({ title, body, action, children, visualClassName, wide = false }: BenefitCardProps) {
  return (
    <Box component="li" className={wide ? `${styles.card} ${styles.wide}` : styles.card}>
      <Box className={styles.cardText}>
        <Typography component="h3" sx={cardTitleSx}>
          {title}
        </Typography>
        <Typography component="p" sx={cardBodySx}>
          {body}
        </Typography>
        {action}
      </Box>
      <Box className={visualClassName ? `${styles.visual} ${visualClassName}` : styles.visual}>{children}</Box>
    </Box>
  );
}

/** The plain tile, for a climb with no beta picture of its own. */
function BetaTile() {
  return (
    <Box aria-hidden className={styles.betaTile}>
      <Box component="span" className={styles.playMark}>
        <PlayArrowRounded fontSize="inherit" />
      </Box>
    </Box>
  );
}

/**
 * This climb's own beta, fanned out, each card with the filmer's handle in the
 * strip the next card leaves uncovered; the plain tile when it has no picture.
 *
 * Only this climb's beta, the links the page already shows in its beta
 * section. Never other climbs' beta: a climber can make their video private at
 * any time, and this page's HTML sits in a shared edge cache for a day, so
 * another climber's revocable media must not be copied into it from elsewhere.
 *
 * Decoration: the beta section above links every video, so this repeats
 * nothing to a screen reader.
 */
function InstantBetaVisual({ climbBeta }: { climbBeta: readonly BetaLink[] }) {
  const fanLinks = dedupeBetaLinks(climbBeta.filter((link) => Boolean(link.thumbnail))).slice(0, MAX_FAN_CARDS);
  if (fanLinks.length === 0) return <BetaTile />;

  return (
    <Box aria-hidden className={styles.fan} data-count={fanLinks.length}>
      {fanLinks.map((link) =>
        link.thumbnail ? (
          <BetaFanCard
            key={link.link}
            thumbnail={link.thumbnail}
            handle={link.foreign_username ? `@${link.foreign_username}` : null}
          />
        ) : null,
      )}
    </Box>
  );
}

/**
 * "What you get in the app": five things the app does, each with a real
 * picture, then the 30-day line and the page's second store pair.
 *
 * Below md the cards are a snap scroller with the next card peeking in; from md
 * they are three across and two wide. Every picture is lazy and sits in a box
 * of fixed height, so nothing moves when it loads, or when the screenshots swap
 * to the reader's phone after mount.
 *
 * The page renders this inside `<Suspense>`, and the 30-day line inside its
 * own: the hero never waits on it, and the store badges never wait on the
 * stats read. The store block carries `data-sticky-install-hide`, so the
 * sticky install bar stays down while these badges are on screen. They are the
 * official store badges, black, so they add no filled action to the screen;
 * `brand-outlined` styles only the "Update the app" button a visitor still in
 * the retired Capacitor app gets instead.
 */
export default async function ClimbAppShowcase({ betaLinks, board }: ClimbAppShowcaseProps) {
  const [{ t }, storeLabels] = await Promise.all([getServerTranslation('climbs'), getStoreButtonLabels()]);

  return (
    <Box component="section" className={styles.section} aria-labelledby="climb-app-showcase-heading">
      <Typography variant="h4" component="h2" id="climb-app-showcase-heading" sx={headingSx}>
        {t('frontDoor.app.heading')}
      </Typography>
      <Typography component="p" sx={leadSx}>
        {t('frontDoor.app.lead')}
      </Typography>

      <MarketingPreviewProvider initialBrowser={SHARED_HTML_BROWSER}>
        {/* Below md this scrolls sideways: focusable, so the arrow keys reach
            every card, and named by the band's heading. */}
        <Box className={styles.scroller} role="region" aria-labelledby="climb-app-showcase-heading" tabIndex={0}>
          <Box component="ul" className={styles.cards}>
            <BenefitCard title={t('frontDoor.app.beta.title')} body={t('frontDoor.app.beta.body')}>
              <InstantBetaVisual climbBeta={betaLinks} />
            </BenefitCard>
            <BenefitCard title={t('frontDoor.app.wall.title')} body={t('frontDoor.app.wall.body')}>
              <MarketingScreenshot
                shot="wall-status"
                alt={t('frontDoor.app.wall.alt')}
                className={styles.phone}
                sizes={PHONE_SIZES}
              />
            </BenefitCard>
            <BenefitCard
              title={t('frontDoor.app.boards.title')}
              body={t('frontDoor.app.boards.body')}
              visualClassName={styles.poster}
            >
              <Image
                src={resolveStaticAssetUrl(POSTER_PATH)}
                alt={t('frontDoor.app.boards.alt')}
                width={POSTER_WIDTH}
                height={POSTER_HEIGHT}
                sizes={POSTER_SIZES}
                className={styles.posterImage}
              />
            </BenefitCard>
            <BenefitCard
              wide
              title={t('frontDoor.app.logbook.title')}
              body={t('frontDoor.app.logbook.body')}
              action={
                <MuiLink component={LocaleLink} href="/bring-your-logbook" sx={cardLinkSx}>
                  {t('frontDoor.app.logbook.link')}
                </MuiLink>
              }
            >
              <MarketingScreenshot
                shot="profile"
                alt={t('frontDoor.app.logbook.alt')}
                className={styles.phone}
                sizes={PHONE_SIZES}
              />
            </BenefitCard>
            <BenefitCard wide title={t('frontDoor.app.workouts.title')} body={t('frontDoor.app.workouts.body')}>
              <MarketingScreenshot
                shot="workouts"
                alt={t('frontDoor.app.workouts.alt')}
                className={styles.phone}
                sizes={PHONE_SIZES}
              />
            </BenefitCard>
          </Box>
        </Box>
      </MarketingPreviewProvider>

      {board && <BoardAppGuideLink board={board} />}

      <Box className={styles.foot}>
        <Suspense fallback={null}>
          <CommunityProofLine />
        </Suspense>
        <Box className={styles.stores} data-cta="app-install" {...{ [STICKY_INSTALL_HIDE_ATTRIBUTE]: '' }}>
          <StoreInstallButtons
            placement="climb-app-module"
            labels={storeLabels}
            appearance="brand-outlined"
            align="start"
            sharedHtml
            qrLanding="climb"
          />
        </Box>
      </Box>
    </Box>
  );
}
