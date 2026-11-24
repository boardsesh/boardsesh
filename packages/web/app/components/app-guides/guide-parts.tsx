import React, { Suspense } from 'react';
import Image from 'next/image';
import Box from '@mui/material/Box';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import Button from '@mui/material/Button';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import LaptopOutlined from '@mui/icons-material/LaptopOutlined';
import PhoneAndroidOutlined from '@mui/icons-material/PhoneAndroidOutlined';
import PhoneIphoneOutlined from '@mui/icons-material/PhoneIphoneOutlined';
import StarRounded from '@mui/icons-material/StarRounded';
import CommunityProofLine from '@/app/components/climb-front-door/community-proof-line';
import LocaleLink from '@/app/components/i18n/locale-link';
import StoreInstallButtons, { type StoreButtonLabels } from '@/app/components/marketing/store-install-buttons';
import StartClimbingButton from '@/app/components/start-climbing-button';
import { brandCtaSx } from '@/app/components/ui/brand-cta';
import { quietLinkSx } from '@/app/components/ui/quiet-link';
import { DEFAULT_LOCALE } from '@/app/lib/i18n/config';
import { buildAppHandoffUrl } from '@/app/lib/app-handoff';
import {
  BOARDSESH_APP_STORE_RATING,
  BOARDSESH_PLAY_RATING,
  type GuidePlacement,
  type PrimaryAction,
  type RunsOn,
} from '@/app/lib/seo/app-guides';
import type { AppGuidePageId } from '@/app/lib/seo/app-guide-model';
import type { AppGuideCopy } from './app-guide-copy';
import type { GuideImage } from './app-guide-assets';
import HoldRing, { type HoldRole } from './hold-ring';
import styles from './app-guide.module.css';

export type T = AppGuideCopy['t'];

export const dateFormat = new Intl.DateTimeFormat(DEFAULT_LOCALE, { dateStyle: 'medium', timeZone: 'UTC' });
const ratingFormat = new Intl.NumberFormat(DEFAULT_LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const BROWSER_CTA_SX = { ...brandCtaSx({ size: 'large' }), flex: 'none' } as const;

/** Eyebrow (ring + label), the section's h2 and an optional lead. */
export function SectionHead({
  id,
  eyebrow,
  ring,
  title,
  lead,
}: {
  id: string;
  eyebrow?: string;
  ring?: HoldRole;
  title: string;
  lead?: React.ReactNode;
}) {
  return (
    <Box className={styles.sectionHead}>
      {eyebrow ? (
        <Typography variant="eyebrow" component="p" className={styles.eyebrow}>
          {ring ? <HoldRing role={ring} /> : null}
          {eyebrow}
        </Typography>
      ) : null}
      <Typography variant="marketingH2" component="h2" id={id}>
        {title}
      </Typography>
      {lead ? (
        <Typography variant="lead" component="p" className={styles.lead}>
          {lead}
        </Typography>
      ) : null}
    </Box>
  );
}

/** The "Source pending" tag: only ever rendered from a `--allow-pending` preview import. */
export function SourcePending({ t }: { t: T }) {
  return (
    <Box component="span" className={styles.pending}>
      {t('appGuides:common.sourcePending')}
    </Box>
  );
}

export function GuideBreadcrumb({ t, crumbs }: { t: T; crumbs: readonly { label: string; path: string }[] }) {
  return (
    <Breadcrumbs aria-label={t('appGuides:common.breadcrumbLabel')} className={styles.crumbs}>
      {crumbs.map((crumb, index) =>
        index === crumbs.length - 1 ? (
          <Typography key={crumb.path} variant="inherit" color="text.primary" aria-current="page">
            {crumb.label}
          </Typography>
        ) : (
          <MuiLink key={crumb.path} component={LocaleLink} href={crumb.path} locale={DEFAULT_LOCALE} sx={quietLinkSx}>
            {crumb.label}
          </MuiLink>
        ),
      )}
    </Breadcrumbs>
  );
}

/** "Works with …" pill: four lit rings, then the compatibility line. */
export function WorksWithPill({ children }: { children: string }) {
  return (
    <Typography component="p" className={styles.worksWith}>
      <Box component="span" className={styles.worksWithDots}>
        <HoldRing role="start" size="xs" />
        <HoldRing role="hand" size="xs" />
        <HoldRing role="finish" size="xs" />
        <HoldRing role="foot" size="xs" />
      </Box>
      {children}
    </Typography>
  );
}

/**
 * Where Boardsesh runs: iPhone, any Android phone, any browser. What each line
 * may claim about lighting comes from the page's registry entry (`runsOn`).
 */
export function RunsOnStrip({ t, runsOn }: { t: T; runsOn: RunsOn }) {
  const body = {
    ios: runsOn.ios === 'wled' ? t('appGuides:common.runsOn.ios.bodyWled') : t('appGuides:common.runsOn.ios.body'),
    android: t('appGuides:common.runsOn.android.body'),
    browser:
      runsOn.browser === 'lights'
        ? t('appGuides:common.runsOn.browser.body')
        : runsOn.browser === 'lightsFamilies'
          ? t('appGuides:common.runsOn.browser.bodyFamilies')
          : t('appGuides:common.runsOn.browser.bodyNoLighting'),
  };
  const items = [
    { id: 'ios', Icon: PhoneIphoneOutlined },
    { id: 'android', Icon: PhoneAndroidOutlined },
    { id: 'browser', Icon: LaptopOutlined },
  ] as const;
  return (
    <Box component="ul" className={styles.runsOn} aria-label={t('appGuides:common.runsOn.label')}>
      {items.map(({ id, Icon }) => (
        <li key={id}>
          <Icon aria-hidden className={styles.runsOnIcon} />
          <span>
            <strong>{t(`appGuides:common.runsOn.${id}.title`)}</strong>
            <span className={styles.runsOnBody}>{body[id]}</span>
          </span>
        </li>
      ))}
    </Box>
  );
}

/**
 * The page's one filled action, saying what it opens ("Browse Kilter climbs"),
 * then both store badges. A desktop visitor can't install a phone app, so the
 * browse action comes first. A board page's button stays on www (the board
 * gallery needs no account); the header's "Start climbing" already opens the
 * browser app. Spray setup opens the app's new-wall flow itself.
 */
export function CtaRow({
  t,
  storeLabels,
  placement,
  pageId,
  action,
}: {
  t: T;
  storeLabels: StoreButtonLabels;
  placement: GuidePlacement;
  pageId: AppGuidePageId;
  action: PrimaryAction;
}) {
  const label = t(`appGuides:common.cta.${pageId}`);
  return (
    <Box className={styles.ctaRow}>
      {action.kind === 'boards' ? (
        <Button
          component={LocaleLink}
          href={action.board ? `/boards#${action.board}` : '/boards'}
          locale={DEFAULT_LOCALE}
          variant="contained"
          size="large"
          sx={BROWSER_CTA_SX}
        >
          {label}
        </Button>
      ) : (
        <StartClimbingButton
          label={label}
          ariaLabel={t('appGuides:common.ctaAria', { label })}
          placement={placement}
          href={buildAppHandoffUrl('/boards/spray/new')}
          variant="contained"
          size="large"
          sx={BROWSER_CTA_SX}
        />
      )}
      <StoreInstallButtons placement={placement} labels={storeLabels} align="start" sharedHtml />
    </Box>
  );
}

/**
 * Both stores' public ratings with the date they were read: "4.7 out of 5 from 72
 * App Store ratings in 17 countries · 4.6 from 38 Google Play ratings · Checked …".
 * Each store's figure links to its listing. No stars, and no rating markup.
 */
export function RatingLine({ t }: { t: T }) {
  const appStore = BOARDSESH_APP_STORE_RATING;
  const play = BOARDSESH_PLAY_RATING;
  // The older of the two reads, so the date never overstates either figure.
  const checkedAt = [appStore.verifiedAt, play.verifiedAt].sort()[0];
  return (
    <Typography component="p" className={styles.ratingLine}>
      <StarRounded aria-hidden className={styles.ratingIcon} />
      <MuiLink href={appStore.source}>
        {t('appGuides:common.rating', {
          rating: ratingFormat.format(appStore.rating),
          count: appStore.count,
          storefronts: appStore.storefronts,
        })}
      </MuiLink>
      <span aria-hidden="true" className={styles.ratingDate}>
        {' · '}
      </span>
      <MuiLink href={play.source}>
        {t('appGuides:common.ratingPlay', { rating: ratingFormat.format(play.rating), count: play.count })}
      </MuiLink>
      <span aria-hidden="true" className={styles.ratingDate}>
        {' · '}
      </span>
      <time dateTime={checkedAt} className={styles.ratingDate}>
        {t('appGuides:common.ratingCheckedAt', { date: dateFormat.format(new Date(checkedAt)) })}
      </time>
    </Typography>
  );
}

/** The store ratings, then the live 30-day line when the cached stats read works. */
export function ProofLines({ t, communityLine = true }: { t: T; communityLine?: boolean }) {
  return (
    <Box className={styles.proof}>
      <RatingLine t={t} />
      {communityLine ? (
        // The 30-day line streams in after the hero; its slot holds the line's usual
        // height so a slow stats read can't push the hero down.
        <Box className={styles.proofCommunity}>
          <Suspense fallback={null}>
            <CommunityProofLine locale={DEFAULT_LOCALE} />
          </Suspense>
        </Box>
      ) : null}
    </Box>
  );
}

export function formatRating(value: number) {
  return ratingFormat.format(value);
}

/**
 * A capture inside a phone bezel. The LCP image passes `priority`: Next's `preload`
 * (the `priority` prop is deprecated), loaded eagerly at high fetch priority.
 */
export function DeviceFrame({
  image,
  alt,
  className,
  priority = false,
  sizes,
}: {
  image: GuideImage;
  alt: string;
  className?: string;
  priority?: boolean;
  sizes: string;
}) {
  return (
    <Box className={[styles.device, className].filter(Boolean).join(' ')}>
      <Image
        src={image.src}
        alt={alt}
        width={image.width}
        height={image.height}
        sizes={sizes}
        preload={priority}
        fetchPriority={priority ? 'high' : undefined}
        loading={priority ? 'eager' : 'lazy'}
      />
    </Box>
  );
}
