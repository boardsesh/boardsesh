import React from 'react';
import Image from 'next/image';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import LaptopOutlined from '@mui/icons-material/LaptopOutlined';
import PhoneAndroidOutlined from '@mui/icons-material/PhoneAndroidOutlined';
import PhoneIphoneOutlined from '@mui/icons-material/PhoneIphoneOutlined';
import LocaleLink from '@/app/components/i18n/locale-link';
import { brandCtaOutlinedSx } from '@/app/components/ui/brand-cta';
import type { StoreButtonLabels } from '@/app/components/marketing/store-install-buttons';
import { cachedCommunityStats } from '@/app/lib/graphql/server-cached-client';
import { DEFAULT_LOCALE } from '@/app/lib/i18n/config';
import {
  BOARDSESH_APP_STORE_RATING,
  BOARDSESH_PLAY_RATING,
  hubBoardHref,
  isClaimVisible,
  type HubGuide,
} from '@/app/lib/seo/app-guides';
import { boardDrawing, guideShot, sprayWallPhoto } from './app-guide-assets';
import {
  CtaRow,
  DeviceFrame,
  ProofLines,
  RunsOnStrip,
  SectionHead,
  WorksWithPill,
  formatRating,
  type T,
} from './guide-parts';
import { BrowserShot, FeatureTiles, hubBoardType } from './guide-sections';
import HoldRing, { type HoldRole } from './hold-ring';
import MysteryBoardArt from './mystery-board-art';
import styles from './app-guide.module.css';

const FAN: readonly {
  shot: 'moonboard' | 'kilter' | 'tension';
  ring: HoldRole;
  position: 'Left' | 'Center' | 'Right';
}[] = [
  { shot: 'moonboard', ring: 'finish', position: 'Left' },
  { shot: 'kilter', ring: 'start', position: 'Center' },
  { shot: 'tension', ring: 'hand', position: 'Right' },
];

export function HubHero({
  guide,
  t,
  storeLabels,
  byline,
}: {
  guide: HubGuide;
  t: T;
  storeLabels: StoreButtonLabels;
  byline: React.ReactNode;
}) {
  return (
    <Box component="section" className={styles.hubHero} aria-labelledby="page-title">
      <WorksWithPill>{t('appGuides:pages.hub.hero.pill')}</WorksWithPill>
      <Typography variant="h1" id="page-title" className={styles.title}>
        {t('appGuides:pages.hub.hero.h1')}
      </Typography>
      <Typography variant="lead" component="p" className={styles.lead}>
        {t('appGuides:pages.hub.hero.lead')}
      </Typography>
      {byline}
      <RunsOnStrip t={t} runsOn={guide.runsOn} />
      <CtaRow t={t} storeLabels={storeLabels} placement={guide.placement} pageId="hub" action={guide.primaryAction} />
      <ProofLines t={t} communityLine={false} />
      {/* Three real climb views, one per board family, on a faded hole grid. */}
      <Box className={styles.fan}>
        {FAN.map(({ shot, position }) => (
          <DeviceFrame
            key={shot}
            image={guideShot(shot)}
            alt={t(`appGuides:common.shots.${shot}`)}
            className={styles[`fan${position}`]}
            sizes="(max-width: 600px) 150px, 248px"
            priority={position === 'Center'}
          />
        ))}
        {FAN.map(({ shot, ring, position }) => (
          <Box
            key={shot}
            component="span"
            aria-hidden="true"
            className={`${styles.fanCaption} ${styles[`fanCaption${position}`]}`}
          >
            <HoldRing role={ring} size="xs" />
            {t(`appGuides:common.fan.${shot}`)}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

const MAKERS_LINK_SX = brandCtaOutlinedSx();

/**
 * Eight whole-tile links (the Aurora brands land on their section of /apps/aurora),
 * then two cards side by side from 900px (stacked below): the spray wall banner
 * and "Want your board here?" for makers. Both are art on top, text under it,
 * and the same height.
 */
export function BoardTileGrid({ guide, t }: { guide: HubGuide; t: T }) {
  const photo = sprayWallPhoto();
  return (
    <Box component="section" id="choose-board" className={styles.section} aria-labelledby="boards-title">
      <SectionHead
        id="boards-title"
        eyebrow={t('appGuides:common.eyebrows.boards')}
        ring="start"
        title={t('appGuides:pages.hub.boards.heading')}
        lead={t('appGuides:pages.hub.boards.lead')}
      />
      <Box component="ul" className={styles.boardGrid}>
        {guide.boards.map((slug) => {
          const drawing = boardDrawing(hubBoardType(slug) as Parameters<typeof boardDrawing>[0]);
          return (
            <li key={slug}>
              <Box
                component={LocaleLink}
                href={hubBoardHref(slug)}
                locale={DEFAULT_LOCALE}
                className={styles.boardTile}
              >
                <Box className={styles.boardTileArt}>
                  <Image
                    src={drawing.src}
                    alt=""
                    width={drawing.width}
                    height={drawing.height}
                    sizes="(max-width: 760px) 50vw, 280px"
                    loading="lazy"
                  />
                </Box>
                <Box className={styles.boardTileBody}>
                  <Typography component="h3" className={styles.h3}>
                    {t(`appGuides:pages.hub.boards.tiles.${slug}.name`)}
                  </Typography>
                  <span className={styles.boardTileMeta}>{t(`appGuides:pages.hub.boards.tiles.${slug}.layouts`)}</span>
                  <span className={styles.goText}>{t(`appGuides:pages.hub.boards.tiles.${slug}.linkText`)}</span>
                </Box>
              </Box>
            </li>
          );
        })}
      </Box>
      <Box className={styles.boardExtras}>
        <Box
          component={LocaleLink}
          href="/compare/spray-wall-apps"
          locale={DEFAULT_LOCALE}
          className={`${styles.extraCard} ${styles.sprayBanner}`}
        >
          <Box className={`${styles.extraArt} ${styles.sprayBannerArt}`}>
            <Image
              src={photo.src}
              alt=""
              width={photo.width}
              height={photo.height}
              sizes="(max-width: 900px) 100vw, 600px"
              loading="lazy"
            />
          </Box>
          <Box className={styles.extraBody}>
            <Typography variant="eyebrow" component="p" className={styles.eyebrow}>
              <HoldRing role="foot" />
              {t('appGuides:common.eyebrows.spray')}
            </Typography>
            <Typography component="h3" className={styles.h3}>
              {t('appGuides:pages.hub.boards.spray.title')}
            </Typography>
            <Typography component="p" color="text.secondary">
              {t('appGuides:pages.hub.boards.spray.body')}
            </Typography>
            <span className={`${styles.goText} ${styles.extraAction}`}>
              {t('appGuides:pages.hub.boards.spray.linkText')}
            </span>
          </Box>
        </Box>
        {guide.makers ? (
          <Box className={`${styles.extraCard} ${styles.makersCard}`}>
            <Box className={styles.extraArt}>
              <MysteryBoardArt />
            </Box>
            <Box className={styles.extraBody}>
              <Typography component="h3" className={styles.h3}>
                {t('appGuides:pages.hub.boards.makers.title')}
              </Typography>
              <Typography component="p" color="text.secondary">
                {t('appGuides:pages.hub.boards.makers.body')}
              </Typography>
              <Button
                component={LocaleLink}
                href={guide.makers.href}
                locale={DEFAULT_LOCALE}
                variant="outlined"
                className={styles.extraAction}
                sx={MAKERS_LINK_SX}
              >
                {t('appGuides:pages.hub.boards.makers.linkText')}
              </Button>
            </Box>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

export function EveryBoardTray({ guide, t }: { guide: HubGuide; t: T }) {
  const tiles = guide.everyBoard
    .filter((tile) => isClaimVisible(guide, `everyBoard.tiles.${tile.id}`))
    .map((tile) => ({
      id: tile.id,
      title: t(`appGuides:pages.hub.everyBoard.tiles.${tile.id}.title`),
      body: t(`appGuides:pages.hub.everyBoard.tiles.${tile.id}.body`),
      pending: tile.pending,
    }));
  return (
    <Box
      component="section"
      id="every-board"
      className={`${styles.section} ${styles.tray}`}
      aria-labelledby="every-title"
    >
      <SectionHead
        id="every-title"
        eyebrow={t('appGuides:common.eyebrows.everyBoard')}
        ring="hand"
        title={t('appGuides:pages.hub.everyBoard.heading')}
        lead={guide.everyBoardLead ? t('appGuides:pages.hub.everyBoard.lead') : undefined}
      />
      <FeatureTiles t={t} tiles={tiles} layout="rows" />
    </Box>
  );
}

/** The same Kilter climb on iPhone and Android, and the browser app as a labelled diagram until a real capture exists. */
export function PlatformTrio({ t }: { t: T }) {
  const figures = [
    { id: 'ios', Icon: PhoneIphoneOutlined, image: guideShot('kilter', 'ios') },
    { id: 'android', Icon: PhoneAndroidOutlined, image: guideShot('kilter', 'android') },
  ] as const;
  return (
    <Box component="section" id="devices" className={styles.section} aria-labelledby="devices-title">
      <SectionHead
        id="devices-title"
        eyebrow={t('appGuides:common.eyebrows.devices')}
        ring="foot"
        title={t('appGuides:pages.hub.devices.heading')}
        lead={t('appGuides:pages.hub.devices.lead')}
      />
      <Box className={styles.platformTrio}>
        {figures.map(({ id, Icon, image }) => (
          <figure key={id}>
            <Box className={styles.platformShot}>
              <Image
                src={image.src}
                alt={t(`appGuides:common.platformAlt.${id}`)}
                width={image.width}
                height={image.height}
                sizes="(max-width: 760px) 50vw, 340px"
                loading="lazy"
              />
            </Box>
            <figcaption className={styles.platformCaption}>
              <Icon aria-hidden />
              <span>{t(`appGuides:pages.hub.devices.captions.${id}`)}</span>
            </figcaption>
          </figure>
        ))}
        <figure>
          <Box className={`${styles.platformShot} ${styles.platformShotBrowser}`}>
            <BrowserShot t={t} sizes="(max-width: 760px) 100vw, 430px" />
          </Box>
          <figcaption className={styles.platformCaption}>
            <LaptopOutlined aria-hidden />
            <span>{t('appGuides:pages.hub.devices.captions.browser')}</span>
          </figcaption>
        </figure>
      </Box>
    </Box>
  );
}

/** Rating, climbers and climbs lit. Renders nothing when the cached stats read fails, like CommunityProofLine. */
export async function StatsBand({ t }: { t: T }) {
  const stats = await cachedCommunityStats();
  if (!stats) return null;
  const numberFormat = new Intl.NumberFormat(DEFAULT_LOCALE);
  // Rolling counts, floored to their unit and marked "+": never rounded up past
  // what happened, and a stat below its unit is left out rather than shown as 0.
  const atLeast = (count: number, unit: number) =>
    count >= unit
      ? t('appGuides:common.atLeast', { value: numberFormat.format(Math.floor(count / unit) * unit) })
      : null;
  const items = [
    {
      id: 'rating',
      value: formatRating(BOARDSESH_APP_STORE_RATING.rating),
      label: t('appGuides:common.ratingStat', {
        count: BOARDSESH_APP_STORE_RATING.count,
        storefronts: BOARDSESH_APP_STORE_RATING.storefronts,
      }),
    },
    {
      id: 'play',
      value: formatRating(BOARDSESH_PLAY_RATING.rating),
      label: t('appGuides:common.ratingPlayStat', { count: BOARDSESH_PLAY_RATING.count }),
    },
    {
      id: 'climbers',
      value: atLeast(stats.climbersLast30Days, 100),
      label: t('appGuides:pages.hub.numbers.climbersLabel'),
    },
    {
      id: 'climbs',
      value: atLeast(stats.litLast30Days, 1000),
      label: t('appGuides:pages.hub.numbers.climbsLabel'),
    },
  ];
  return (
    <Box component="section" id="numbers" className={styles.section} aria-labelledby="numbers-title">
      <Typography component="h2" id="numbers-title" className={styles.visuallyHidden}>
        {t('appGuides:common.numbersHeading')}
      </Typography>
      <Box component="ul" className={styles.stats}>
        {items
          .flatMap((item) => (item.value === null ? [] : [item]))
          .map((item) => (
            <li key={item.id}>
              <span className={styles.statNumber}>{item.value}</span>
              <Typography component="span" color="text.secondary">
                {item.label}
              </Typography>
            </li>
          ))}
      </Box>
      <Typography component="p" color="text.secondary" className={styles.statsNote}>
        {t('appGuides:pages.hub.numbers.freshness')}
      </Typography>
    </Box>
  );
}
