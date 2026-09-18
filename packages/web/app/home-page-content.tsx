'use client';

import React from 'react';

import Image from 'next/image';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import InstallMobileOutlined from '@mui/icons-material/InstallMobileOutlined';
import SystemUpdateOutlined from '@mui/icons-material/SystemUpdateOutlined';
import PeopleOutlined from '@mui/icons-material/PeopleOutlined';
import BluetoothOutlined from '@mui/icons-material/BluetoothOutlined';
import LocalOfferOutlined from '@mui/icons-material/LocalOfferOutlined';
import PlaceOutlined from '@mui/icons-material/PlaceOutlined';
import WarningAmberOutlined from '@mui/icons-material/WarningAmberOutlined';
import { IOS_APP_STORE_URL, ANDROID_PLAY_STORE_URL } from '@/app/lib/store-urls';
import { resolveHeroInstall, type InstallPlatform, type HeroInstallStore } from '@/app/lib/hero-install';
import { useTranslation } from 'react-i18next';
import { themeTokens } from '@/app/theme/theme-config';
import { brandCtaSx } from '@/app/components/ui/brand-cta';
import LocaleLink from '@/app/components/i18n/locale-link';
import PopularBoardRail from '@/app/components/board-entity/popular-board-rail';
import { APP_URL } from '@/app/lib/app-origin';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import type { RecentBetaLinkRow } from '@/app/lib/server-recent-beta-links';
import HomeRecentBetaSection from '@/app/components/beta-videos/home-recent-beta-section';
import HomeGymCard from '@/app/components/home-gym-card/home-gym-card';
import StartClimbingButton from '@/app/components/start-climbing-button';
import { resolveShellStaticAssetUrl } from '@/app/lib/shell-static-asset-url';
import { track } from '@/app/lib/analytics';
import { APP_INSTALL_CLICK_EVENT, buildAppInstallClickProperties } from '@/app/lib/app-install-event';
import { useInstallPlatform } from '@/app/hooks/use-install-platform';
import OnboardingCard from '@/app/components/home/onboarding-card';
import InstallAppCard from '@/app/components/home/install-app-card';
import DiscordIcon from '@/app/components/home/discord-icon';

const DISCORD_INVITE_URL = 'https://discord.gg/YXA8GsXfQK';

type HomePageContentProps = {
  initialPopularConfigs?: PopularBoardConfig[];
  initialRecentBeta?: RecentBetaLinkRow[];
  /**
   * Sections rendered on the SERVER and passed down as slots.
   *
   * This component is `'use client'` because the hero reads the visitor's
   * platform. These three are async React Server Components that fetch their
   * own data, so they cannot be imported here — a client module cannot await a
   * server one. Rendering them in `page.tsx` and handing them down keeps their
   * markup server-rendered (which is the point: the gym links and the marketing
   * copy have to be in the first HTML a crawler sees) while letting them sit
   * between two client blocks.
   */
  gymSearch?: React.ReactNode;
  featureStrip?: React.ReactNode;
  supportBlock?: React.ReactNode;
};

// Shared rounded-full brand CTA styling for the hero buttons — the Velvet violet
// fill with an amber spark glow (Velvet's warm half on the hero). The
// scheme-aware fill clears AA with white text in both modes. The global MUI
// Button override adds a translateY(-1px) on hover; cancel it so the CTA stays
// anchored under the warm glow.
// The homepage hero is the one surface that carries the amber glow.
const HERO_CTA_SX = brandCtaSx({ size: 'large', glow: true });

// The second store on desktop: outlined, so it is clearly the same kind of
// action as the primary without competing with it for weight.
const HERO_SECONDARY_CTA_SX = {
  borderRadius: `${themeTokens.borderRadius.full}px`,
  textTransform: 'none',
  fontWeight: themeTokens.typography.fontWeight.semibold,
  px: 4,
  py: 1.5,
  fontSize: themeTokens.typography.fontSize.lg,
  color: 'var(--color-primary)',
  borderColor: 'var(--separator)',
  '&:hover': {
    borderColor: 'var(--color-primary)',
    backgroundColor: 'var(--semantic-selected-light)',
    transform: 'none',
  },
} as const;

// The web hand-off reads as a link, so it takes the foreground violet rather
// than the fill — #A78BFA on text, never behind white.
const HERO_WEB_CTA_SX = {
  textTransform: 'none',
  fontWeight: themeTokens.typography.fontWeight.semibold,
  color: 'var(--color-primary)',
  '&:hover': { backgroundColor: 'var(--semantic-selected-light)' },
} as const;

export default function HomePageContent({
  initialPopularConfigs,
  initialRecentBeta = [],
  gymSearch,
  featureStrip,
  supportBlock,
}: HomePageContentProps) {
  const { t } = useTranslation('marketing');
  const { platform: installPlatform, nativeStore } = useInstallPlatform();

  // Hero CTA drives app installs. The store, label and icon follow the detected
  // platform — except on desktop, where there is no phone OS to infer and the
  // hero offers both stores rather than guessing.
  const heroInstall = resolveHeroInstall(installPlatform, nativeStore);
  const HeroInstallIcon = heroInstall.mode === 'update' ? SystemUpdateOutlined : InstallMobileOutlined;
  const heroInstallButtons = heroInstall.stores.map((store, index) => ({
    store,
    url: store === 'android' ? ANDROID_PLAY_STORE_URL : IOS_APP_STORE_URL,
    source: store === 'android' ? ('google-play' as const) : ('app-store' as const),
    label:
      heroInstall.mode === 'update'
        ? t('home.hero.ctaUpdate')
        : store === 'android'
          ? t('home.hero.ctaInstallAndroid')
          : t('home.hero.ctaInstallIos'),
    // Only the first store reads as the primary action; a second filled pill of
    // equal weight would be no hierarchy at all.
    primary: index === 0,
  }));

  return (
    // Page-level translate="no" was removed because it blocked browser
    // translation of every static UI label on this page. The error boundary
    // (app/error.tsx) auto-recovers from any residual translator-DOM
    // NotFoundError (issue #2064).
    <Box
      sx={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Box
        component="main"
        sx={{
          flex: 1,
          px: 2,
          py: 2,
          pt: 'var(--global-header-height)',
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
        }}
      >
        {/* Hero: Install-the-app CTA */}
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            textAlign: 'center',
            gap: 2,
            py: 1,
          }}
        >
          <Image
            src={resolveShellStaticAssetUrl('/brand/boardsesh-mark.png')}
            width={130}
            height={130}
            // i18n-ignore-next-line -- brand name, not translated
            alt="Boardsesh"
            priority
          />
          {/* `component` fixes the semantics: MUI maps a variant to its literal
              tag, so this used to server-render no <h1> at all on the
              highest-traffic indexable page on the site. The size is set here
              rather than by variant — the hero is the one large thing on the
              page and it was rendering at h5, smaller than the section headings
              further down. */}
          <Typography
            variant="h3"
            component="h1"
            fontWeight={themeTokens.typography.fontWeight.bold}
            sx={{
              color: 'var(--bs-text-brand-primary)',
              fontSize: { xs: 30, sm: 40 },
              lineHeight: 1.15,
              letterSpacing: '-0.02em',
              // Cap the measure so the title breaks in a deliberate place.
              maxInlineSize: '18ch',
            }}
          >
            {t('home.hero.title')}
          </Typography>
          <Typography
            variant="body1"
            sx={{ color: 'var(--bs-text-brand-muted)', maxWidth: 420, fontSize: { xs: 16, sm: 18 } }}
          >
            {t('home.hero.subtitle')}
          </Typography>
          {/* Store-first, per the marketing wireframe: the app is the product
              and the web is the way in for someone who has not installed it.
              A phone browser gets the one store that matches it; a desktop
              browser gets both, because there is nothing to infer from. The
              whole row self-suppresses inside the native app. */}
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, justifyContent: 'center', mt: 1 }}>
            {heroInstallButtons.map((button) => (
              <Button
                key={button.store}
                variant={button.primary ? 'contained' : 'outlined'}
                size="large"
                startIcon={<HeroInstallIcon />}
                onClick={() => {
                  track(
                    APP_INSTALL_CLICK_EVENT,
                    buildAppInstallClickProperties({
                      platform: button.store,
                      source: button.source,
                      placement: 'hero',
                      mode: heroInstall.mode,
                    }),
                  );
                  window.open(button.url, '_blank', 'noopener,noreferrer');
                }}
                sx={button.primary ? HERO_CTA_SX : HERO_SECONDARY_CTA_SX}
              >
                {button.label}
              </Button>
            ))}
          </Box>
          {/* Secondary: hand off to the Expo-web app (single sign-on when logged
              in, the app's own login otherwise). A text link, not a second
              filled pill — two equal-weight buttons is no hierarchy at all. */}
          <StartClimbingButton
            label={t('home.hero.startClimbingWeb')}
            ariaLabel={t('home.hero.startClimbingAria')}
            size="large"
            variant="text"
            sx={HERO_WEB_CTA_SX}
          />
        </Box>

        {/* Section order follows the marketing wireframe: find a board, jump
            onto one, see what the crew is doing, then what the app adds. */}

        {/* "Find a board near you" — the gym directory teaser. Server-rendered,
            so its gym links are crawlable. */}
        {gymSearch}

        {/* Board discovery — a static, crawlable grid of the popular configs the
            page already SSR-fetches. */}
        <PopularBoardRail configs={initialPopularConfigs ?? []} />

        {/* Recent beta videos from across the community. */}
        <HomeRecentBetaSection initialRecentBeta={initialRecentBeta} />

        {/* "Board night, sorted" — what the app does that a shared phone on the
            mat does not. */}
        {featureStrip}

        {/* Onboarding Cards */}
        {/* The stack used to be a single column capped at 420px, which on a
            1440px screen was a narrow ribbon of cards down the middle with
            empty violet either side. A CSS grid (no JS breakpoint) gives two
            columns once there is room and stays one column on a phone. The
            section header spans the full width via gridColumn: '1 / -1'. */}
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' },
            gap: 1.5,
            width: '100%',
            maxWidth: { xs: 420, md: 880 },
            mx: 'auto',
          }}
        >
          <Typography
            variant="body2"
            fontWeight={themeTokens.typography.fontWeight.semibold}
            sx={{
              gridColumn: '1 / -1',
              color: 'var(--neutral-400)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              fontSize: themeTokens.typography.fontSize.xs,
              px: 0.5,
            }}
          >
            {t('home.onboardingHeader')}
          </Typography>

          <Box sx={{ gridColumn: '1 / -1' }}>
            <InstallAppCard platform={installPlatform} />
          </Box>

          {/* Signed-in only: the gym you help run, with Manage / View links.
              Self-gates to null for signed-out visitors and for climbers with
              no gym. */}
          <Box sx={{ gridColumn: '1 / -1' }}>
            <HomeGymCard />
          </Box>

          {/* The "find a gym" nudge the drawers used to carry, restored now that
              the directory exists. Everyone sees it, including the signed-out
              visitors HomeGymCard renders nothing for. */}
          <OnboardingCard
            icon={<PlaceOutlined />}
            title={t('home.cards.gymTitle')}
            description={t('home.cards.gymDescription')}
            accent="brand"
            href="/gyms"
          />

          <OnboardingCard
            icon={<WarningAmberOutlined />}
            title={t('home.cards.auroraTitle')}
            description={t('home.cards.auroraDescription')}
            accent="brand"
            href="/aurora-migration"
          />

          <OnboardingCard
            icon={<LocalOfferOutlined />}
            title={t('home.cards.playlistTitle')}
            description={t('home.cards.playlistDescription')}
            accent="brand"
            href="/playlists"
          />

          <OnboardingCard
            icon={<BluetoothOutlined />}
            title={t('home.cards.bluetoothTitle')}
            description={t('home.cards.bluetoothDescription')}
            accent="spark"
            href={APP_URL}
            external
          />

          <OnboardingCard
            icon={<PeopleOutlined />}
            title={t('home.cards.crewTitle')}
            description={t('home.cards.crewDescription')}
            accent="spark"
            href={APP_URL}
            external
          />

          <OnboardingCard
            icon={<DiscordIcon />}
            title={t('home.cards.discordTitle')}
            description={t('home.cards.discordDescription')}
            accent="info"
            href={DISCORD_INVITE_URL}
            external
            newTab
          />
        </Box>

        {/* Support — last thing before the footer, so it catches people who
            have just read what the app does and are already convinced. */}
        {supportBlock}
      </Box>
    </Box>
  );
}
