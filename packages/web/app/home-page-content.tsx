import React from 'react';
import Image from 'next/image';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import { isBoardTypeVisible } from '@boardsesh/board-config/visibility';
import {
  compatibilityBoardSelected,
  spraywallPathClicked,
  gymClaimPathClicked,
  partnerContactClicked,
} from '@boardsesh/analytics';
import { boardTypeLabel } from '@boardsesh/board-constants/board-type-labels';
import StoreInstallButtons from '@/app/components/marketing/store-install-buttons';
import { PageSection, PageCard } from '@/app/components/ui/page-shell';
import LocaleLink from '@/app/components/i18n/locale-link';
import { resolveMarketingStaticAssetUrl } from '@/app/lib/marketing-static-asset-url';
import { DEFAULT_LOCALE, type Locale } from '@/app/lib/i18n/config';
import HomeRecentBetaSection from '@/app/components/beta-videos/home-recent-beta-section';
import { MarketingScreenshot } from '@/app/components/marketing/marketing-screenshot';
import { MarketingPreviewSwitchControl } from '@/app/components/marketing/marketing-preview-switch-control';
import HomeShowcaseVideo from '@/app/components/home/home-showcase-video';
import { WebsiteJourneyLink } from '@/app/components/marketing/website-journey-link';
import { WebsiteJourneyChip } from '@/app/components/marketing/website-journey-chip';
import { QuantumCompatibilityChip } from '@/app/components/marketing/quantum-compatibility-chip';
import { getServerTranslationForLocale, loadServerResources } from '@/app/lib/i18n/server';
import { selectI18nResources } from '@/app/lib/i18n/select-resources';
import styles from './home-page-content.module.css';

type HomePageContentProps = {
  locale: Locale;
  heroProof?: string;
  /**
   * The laptop's install block: the QR code card with both store badges
   * (`PhoneQrCard`). Rendered by the server page and handed down, so the code
   * arrives as plain SVG and `qrcode.react` never ships to the browser. Shown
   * from 1100px; below that the hero shows this visitor's store badge instead.
   */
  desktopInstall?: React.ReactNode;
  gymSearch?: React.ReactNode;
  featureStrip?: React.ReactNode;
  supportBlock?: React.ReactNode;
  supportBanner?: React.ReactNode;
  trustFaq?: React.ReactNode;
};
const LINK_TARGET = { display: 'inline-flex', alignItems: 'center', minHeight: 44 } as const;

export default async function HomePageContent({
  locale,
  heroProof,
  desktopInstall,
  gymSearch,
  featureStrip,
  supportBlock,
  supportBanner,
  trustFaq,
}: HomePageContentProps) {
  const [{ t }, betaResources] = await Promise.all([
    getServerTranslationForLocale(locale, 'marketing'),
    loadServerResources(locale, ['common']),
  ]);
  const { t: website } = await getServerTranslationForLocale(locale, 'website');
  const showsHeroVideo = locale === 'en-US';
  return (
    <Box component="main" className={styles.main} sx={{ pt: 'var(--global-header-height)' }}>
      {supportBanner}
      <Box component="section" className={styles.hero}>
        <Box className={styles.heroCopy}>
          <MuiLink
            component={LocaleLink}
            href="/boards"
            underline="always"
            className={styles.heroEyebrow}
            sx={LINK_TARGET}
          >
            {t('home.hero.eyebrow')}
          </MuiLink>
          <Typography component="h1" className={styles.heroTitle}>
            {t('home.hero.title')}
          </Typography>
          <Typography component="p" className={styles.heroLead}>
            {t('home.hero.subtitle')}
          </Typography>
          {/* Phones (and narrow windows): the official badge for this visitor's
              store. A phone that scanned the laptop's code lands here, so the
              badge's link id says `hero.desktop` after a scan. */}
          <Box className={styles.heroActions}>
            <StoreInstallButtons
              placement="hero"
              sharedHtml={showsHeroVideo}
              align="start"
              qrLanding="home"
              labels={{
                ios: t('home.hero.ctaInstallIos'),
                android: t('home.hero.ctaInstallAndroid'),
                update: t('home.hero.ctaUpdate'),
                locale,
              }}
            />
          </Box>
          {desktopInstall ? <Box className={styles.heroDesktopInstall}>{desktopInstall}</Box> : null}
          {/* Under whichever install block this width shows: the board app guides.
              `/apps` is English-only, so every homepage links the unprefixed path
              (no locale redirect) and the non-English labels say "(in English)". */}
          <MuiLink
            component={LocaleLink}
            href="/apps"
            locale={DEFAULT_LOCALE}
            hrefLang="en"
            underline="always"
            sx={LINK_TARGET}
          >
            {t('home.hero.compareApps')}
          </MuiLink>
        </Box>
        <Box className={styles.previewGroup}>
          {showsHeroVideo ? (
            <Box className={`${styles.heroPreview} ${styles.heroShowcase}`}>
              <HomeShowcaseVideo
                copy={{
                  videoLabel: t('home.showcase.videoLabel'),
                  unsupported: t('home.showcase.unsupported'),
                  play: t('home.showcase.play'),
                  pause: t('home.showcase.pause'),
                  scenes: ['boards', 'spray', 'wall', 'crew', 'workouts', 'island', 'log', 'outro'].map((id) => ({
                    id,
                    headline: t(`home.showcase.scenes.${id}`),
                  })),
                }}
              />
            </Box>
          ) : (
            <>
              <Box className={styles.heroPreview}>
                <MarketingScreenshot
                  shot="tension"
                  alt={t('home.hero.tensionShotAlt')}
                  sizes="(max-width: 760px) 42vw, 230px"
                  className={`${styles.previewPhone} ${styles.previewLeft}`}
                />
                <MarketingScreenshot
                  shot="moonboard"
                  alt={t('home.hero.moonboardShotAlt')}
                  sizes="(max-width: 760px) 42vw, 230px"
                  className={`${styles.previewPhone} ${styles.previewRight}`}
                />
                <MarketingScreenshot
                  shot="kilter"
                  alt={t('home.hero.playShotAlt')}
                  sizes="(max-width: 760px) 48vw, 260px"
                  className={`${styles.previewPhone} ${styles.previewPrimary}`}
                />
              </Box>
              <MarketingPreviewSwitchControl
                labels={{ label: t('preview.label'), ios: t('preview.ios'), android: t('preview.android') }}
              />
            </>
          )}
        </Box>
      </Box>
      <PageCard className={styles.sprayCard}>
        <PageSection title={website('sprayTitle')} lead={website('sprayLead')}>
          <WebsiteJourneyLink href="/spraywalls" event={spraywallPathClicked('home-chip')} sx={LINK_TARGET}>
            {website('sprayRoute')}
          </WebsiteJourneyLink>
          <MuiLink component={LocaleLink} href="/help/spray-walls" sx={{ ...LINK_TARGET, ml: 2 }}>
            {website('photoGuide')}
          </MuiLink>
        </PageSection>
        {/* The real home wall /spraywalls shows: beside the copy on a laptop, under it on a phone. */}
        <Image
          src={resolveMarketingStaticAssetUrl('/images/help/spray-wall-photo.webp')}
          alt={website('homeSprayPhotoAlt')}
          width={1752}
          height={2047}
          sizes="(max-width: 760px) 90vw, 320px"
          loading="lazy"
          className={styles.sprayPhoto}
        />
      </PageCard>
      <PageSection title={website('boardChoices')}>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          {SUPPORTED_BOARDS.filter((board) => board !== 'spray' && isBoardTypeVisible(board)).map((board) => (
            <WebsiteJourneyChip
              key={board}
              href={`/boards#${board}`}
              event={compatibilityBoardSelected(board, 'home-chip')}
              label={boardTypeLabel(board)}
            />
          ))}
          <QuantumCompatibilityChip />
          <WebsiteJourneyChip
            href="/spraywalls"
            event={spraywallPathClicked('home-chip')}
            label={website('wallCard')}
          />
        </Box>
        <MuiLink component={LocaleLink} href="/apps" locale="en-US" sx={{ ...LINK_TARGET, mt: 2 }}>
          {website('appGuidesLink')}
        </MuiLink>
      </PageSection>
      <PageCard>
        <PageSection title={website('importTitle')} lead={website('importBody')} className={styles.importBand}>
          <MuiLink component={LocaleLink} href="/bring-your-logbook" sx={LINK_TARGET} className={styles.importAction}>
            {website('importLink')}
          </MuiLink>
          <Typography variant="body2" color="text.secondary">
            {website('trust')}
          </Typography>
        </PageSection>
      </PageCard>
      {featureStrip}
      <HomeRecentBetaSection
        locale={locale}
        resources={selectI18nResources(betaResources, { common: ['betaVideos'] })}
        title={t('home.recentBeta.title')}
        lead={t('home.recentBeta.lead')}
      />
      {heroProof ? (
        <Box component="aside" className={styles.proofStrip}>
          <Typography component="p" variant="h5">
            {heroProof}
          </Typography>
          <Typography component="p" variant="body2" color="text.secondary">
            {website('proofNote')}
          </Typography>
        </Box>
      ) : null}
      {gymSearch}
      <PageSection title={website('runWall')}>
        <Box className={styles.wallGrid}>
          <PageCard>
            <PageSection headingLevel={3} title={website('gymCard')} lead={website('gymBody')}>
              <WebsiteJourneyLink href="/gyms?claim=1" event={gymClaimPathClicked('home')} sx={LINK_TARGET}>
                {website('claimGym')}
              </WebsiteJourneyLink>
              <MuiLink component={LocaleLink} href="/for-gyms" sx={LINK_TARGET}>
                {website('forGymsTitle')}
              </MuiLink>
            </PageSection>
          </PageCard>
          <PageCard>
            <PageSection headingLevel={3} title={website('wallCard')} lead={website('sprayNoLights')}>
              <WebsiteJourneyLink href="/spraywalls" event={spraywallPathClicked('home-chip')} sx={LINK_TARGET}>
                {website('sprayRoute')}
              </WebsiteJourneyLink>
            </PageSection>
          </PageCard>
          <PageCard>
            <PageSection headingLevel={3} title={website('partnerCard')} lead={website('partnerBody')}>
              <WebsiteJourneyLink
                href="mailto:support@boardsesh.com?subject=Boardsesh%20wall%20partnership"
                event={partnerContactClicked('partner', 'home')}
                sx={LINK_TARGET}
              >
                {website('contact')}
              </WebsiteJourneyLink>
            </PageSection>
          </PageCard>
        </Box>
      </PageSection>
      {trustFaq}
      {supportBlock}
    </Box>
  );
}
