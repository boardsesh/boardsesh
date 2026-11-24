import React, { Suspense } from 'react';
import Image from 'next/image';
import Box from '@mui/material/Box';
import Breadcrumbs from '@mui/material/Breadcrumbs';
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
import { BOARDSESH_APP_STORE_RATING, type GuidePlacement } from '@/app/lib/seo/app-guides';
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
 * Where Boardsesh runs: iPhone, any Android phone, any browser. `browserLighting`
 * comes from the page's registry entry: off, the browser line says what the
 * browser app does without claiming it lights this board.
 */
export function RunsOnStrip({ t, browserLighting }: { t: T; browserLighting: boolean }) {
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
            <span className={styles.runsOnBody}>
              {id === 'browser' && !browserLighting
                ? t('appGuides:common.runsOn.browser.bodyNoLighting')
                : t(`appGuides:common.runsOn.${id}.body`)}
            </span>
          </span>
        </li>
      ))}
    </Box>
  );
}

/**
 * The page's one filled action, "Open it in your browser" (a desktop visitor can't
 * install a phone app), then both store badges.
 */
export function CtaRow({
  t,
  storeLabels,
  placement,
}: {
  t: T;
  storeLabels: StoreButtonLabels;
  placement: GuidePlacement;
}) {
  const label = t('appGuides:common.openWebApp');
  return (
    <Box className={styles.ctaRow}>
      <StartClimbingButton
        label={label}
        ariaLabel={t('appGuides:common.openWebAppLabel')}
        placement={placement}
        variant="contained"
        size="large"
        sx={BROWSER_CTA_SX}
      />
      <StoreInstallButtons placement={placement} labels={storeLabels} align="start" sharedHtml />
    </Box>
  );
}

/** The dated all-storefront App Store rating, then the live 30-day line when the cached stats read works. */
export function ProofLines({ t, communityLine = true }: { t: T; communityLine?: boolean }) {
  const rating = BOARDSESH_APP_STORE_RATING;
  return (
    <Box className={styles.proof}>
      <Typography component="p" className={styles.ratingLine}>
        <StarRounded aria-hidden className={styles.ratingIcon} />
        <MuiLink href={rating.source}>
          {t('appGuides:common.rating', {
            rating: ratingFormat.format(rating.rating),
            count: rating.count,
            storefronts: rating.storefronts,
          })}
        </MuiLink>
        <span aria-hidden="true" className={styles.ratingDate}>
          ·
        </span>
        <time dateTime={rating.verifiedAt} className={styles.ratingDate}>
          {t('appGuides:common.ratingCheckedAt', { date: dateFormat.format(new Date(rating.verifiedAt)) })}
        </time>
      </Typography>
      {communityLine ? (
        <Suspense fallback={null}>
          <CommunityProofLine locale={DEFAULT_LOCALE} />
        </Suspense>
      ) : null}
    </Box>
  );
}

export function formatRating(value: number) {
  return ratingFormat.format(value);
}

/** A capture inside a phone bezel. The LCP image passes `priority`, which also turns lazy loading off. */
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
        priority={priority}
        loading={priority ? undefined : 'lazy'}
      />
    </Box>
  );
}
