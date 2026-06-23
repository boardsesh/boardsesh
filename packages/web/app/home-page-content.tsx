'use client';

import React, { useState, useCallback, useEffect } from 'react';
import dynamic from 'next/dynamic';
import Image from 'next/image';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardActionArea from '@mui/material/CardActionArea';
import PlayArrowRounded from '@mui/icons-material/PlayArrowRounded';
import PlayCircleOutlineOutlined from '@mui/icons-material/PlayCircleOutlineOutlined';
import PeopleOutlined from '@mui/icons-material/PeopleOutlined';
import BluetoothOutlined from '@mui/icons-material/BluetoothOutlined';
import LocalOfferOutlined from '@mui/icons-material/LocalOfferOutlined';
import WarningAmberOutlined from '@mui/icons-material/WarningAmberOutlined';
import AndroidOutlined from '@mui/icons-material/AndroidOutlined';
import Skeleton from '@mui/material/Skeleton';
import SvgIcon from '@mui/material/SvgIcon';
import { isNativeApp, isCapacitorWebView, waitForCapacitor } from '@/app/lib/ble/capacitor-utils';
import { IOS_APP_STORE_URL, ANDROID_PLAY_STORE_URL } from '@/app/lib/store-urls';
import { useSession } from 'next-auth/react';
import { useLocaleRouter } from '@/app/lib/i18n/use-locale-router';
import { useTranslation } from 'react-i18next';
import { themeTokens } from '@/app/theme/theme-config';
import { usePersistentSession } from '@/app/components/persistent-session';
import BoardDiscoveryScroll from '@/app/components/board-scroll/board-discovery-scroll';
import { constructBoardSlugListUrl, constructClimbListWithSlugs, tryConstructSlugListUrl } from '@/app/lib/url-utils';
import { getDefaultAngleForBoard } from '@/app/lib/board-config-for-playlist';
import type { BoardConfigData } from '@/app/lib/server-board-configs';
import type { UserBoard, PopularBoardConfig } from '@boardsesh/shared-schema';
import type { RecentBetaLinkRow } from '@/app/lib/server-recent-beta-links';
import HomeRecentBetaSection from '@/app/components/beta-videos/home-recent-beta-section';
import { track } from '@/app/lib/analytics';
import { setClimbSessionCookie } from '@/app/lib/climb-session-cookie';
import { useOnboardingTourOptional } from '@/app/components/onboarding/onboarding-tour-provider';
import { TOUR_OPEN_START_SESH_EVENT } from '@/app/components/onboarding/onboarding-tour-events';

const StartSeshDrawer = dynamic(() => import('@/app/components/session-creation/start-sesh-drawer'), { ssr: false });

const UnifiedSearchDrawer = dynamic(() => import('@/app/components/search-drawer/unified-search-drawer'), {
  ssr: false,
});

const BoardSelectorDrawer = dynamic(() => import('@/app/components/board-selector-drawer/board-selector-drawer'), {
  ssr: false,
});

type HomePageContentProps = {
  boardConfigs: BoardConfigData;
  initialPopularConfigs?: PopularBoardConfig[];
  initialRecentBeta?: RecentBetaLinkRow[];
};

type OnboardingCardAccent = 'action' | 'social' | 'help' | 'v11' | 'v12' | 'v13' | 'none';

type OnboardingCardProps = {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  /**
   * Category colour-coding for the icon chip. Cards that do similar jobs
   * share an accent so the list is scannable. The whole card remains the
   * CTA — the chip colour is metadata, not a CTA token. Defaults to
   * 'action' (rose) for backwards compatibility.
   */
  accent?: OnboardingCardAccent;
};

// Soft tint backgrounds (~10% alpha) for each accent. Inlined rather than
// added as CSS vars — these only render here. The v11/v12/v13 accents tie
// the onboarding stack to the project-zone V-grade scale that the brand
// mark is built on (see designer brief §2a).
const accentSurface: Record<OnboardingCardAccent, string> = {
  action: 'var(--semantic-selected-light)', // existing rose tint
  social: 'rgba(156, 39, 176, 0.10)', // V11 purple
  help: 'rgba(94, 100, 145, 0.12)', // violet-slate (Velvet info) — same family as the rest
  v11: 'rgba(156, 39, 176, 0.10)', // V11 #9C27B0
  v12: 'rgba(123, 31, 162, 0.10)', // V12 #7B1FA2
  v13: 'rgba(106, 27, 154, 0.10)', // V13 #6A1B9A
  none: 'transparent',
};

function resolveAccentIconColor(accent: OnboardingCardAccent): string {
  switch (accent) {
    case 'social':
      return themeTokens.colors.purple;
    case 'help':
      return 'var(--color-info)';
    case 'v11':
      return '#9C27B0';
    case 'v12':
      return '#7B1FA2';
    case 'v13':
      return '#6A1B9A';
    case 'none':
      return 'inherit';
    case 'action':
    default:
      return 'var(--color-primary)';
  }
}

function DiscordIcon() {
  return (
    <SvgIcon viewBox="0 -28.5 256 256">
      <path d="M216.856 16.597A208.502 208.502 0 0 0 164.042 0c-2.275 4.113-4.933 9.645-6.766 14.046-19.692-2.961-39.203-2.961-58.533 0-1.832-4.4-4.55-9.933-6.846-14.046a207.809 207.809 0 0 0-52.855 16.638C5.618 67.147-3.443 116.4 1.087 164.956c22.169 16.555 43.653 26.612 64.775 33.193a161.094 161.094 0 0 0 13.882-22.584 136.428 136.428 0 0 1-21.846-10.632 108.636 108.636 0 0 0 5.356-4.237c42.122 19.702 87.89 19.702 129.51 0a131.66 131.66 0 0 0 5.355 4.237 136.07 136.07 0 0 1-21.886 10.653c4.006 8.02 8.638 15.67 13.862 22.564 21.142-6.58 42.646-16.637 64.815-33.213 5.316-56.288-9.08-105.09-38.056-148.36ZM85.474 135.095c-12.645 0-23.015-11.805-23.015-26.18s10.149-26.2 23.015-26.2c12.867 0 23.236 11.804 23.015 26.2.02 14.375-10.148 26.18-23.015 26.18Zm85.051 0c-12.645 0-23.014-11.805-23.014-26.18s10.148-26.2 23.014-26.2c12.867 0 23.236 11.804 23.015 26.2 0 14.375-10.148 26.18-23.015 26.18Z" />
    </SvgIcon>
  );
}

function OnboardingCard({ icon, title, description, onClick, accent = 'action' }: OnboardingCardProps) {
  return (
    <Card
      variant="outlined"
      sx={{
        borderRadius: `${themeTokens.borderRadius.lg}px`,
        border: '1px solid var(--neutral-200)',
        transition: themeTokens.transitions.fast,
        '&:hover': {
          borderColor: 'var(--neutral-300)',
          boxShadow: themeTokens.shadows.sm,
        },
      }}
    >
      <CardActionArea onClick={onClick} sx={{ p: 0 }}>
        <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 2, px: 2.5 }}>
          <Box
            sx={{
              width: 44,
              height: 44,
              borderRadius: `${themeTokens.borderRadius.md}px`,
              backgroundColor: accentSurface[accent],
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              color: resolveAccentIconColor(accent),
            }}
          >
            {icon}
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography
              variant="body1"
              fontWeight={themeTokens.typography.fontWeight.semibold}
              sx={{
                color: 'var(--neutral-900)',
                lineHeight: themeTokens.typography.lineHeight.tight,
              }}
            >
              {title}
            </Typography>
            <Typography variant="body2" sx={{ color: 'var(--neutral-500)', mt: 0.25 }}>
              {description}
            </Typography>
          </Box>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}

type InstallPlatform = 'unknown' | 'native' | 'android-web' | 'other-web';

function InstallAppShadowCard() {
  return (
    <Card
      variant="outlined"
      aria-hidden
      sx={{
        borderRadius: `${themeTokens.borderRadius.lg}px`,
        border: '1px solid var(--neutral-200)',
        transition: themeTokens.transitions.fast,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 2, px: 2.5 }}>
        <Skeleton
          variant="rounded"
          width={44}
          height={44}
          sx={{ borderRadius: `${themeTokens.borderRadius.md}px`, flexShrink: 0 }}
        />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Skeleton variant="text" width="60%" height={20} />
          <Skeleton variant="text" width="85%" height={18} />
        </Box>
      </Box>
    </Card>
  );
}

function InstallAppCard({ platform }: { platform: InstallPlatform }) {
  const { t } = useTranslation('marketing');

  if (platform === 'unknown') return <InstallAppShadowCard />;
  if (platform === 'native') return null;

  if (platform === 'android-web') {
    return (
      <OnboardingCard
        icon={<AndroidOutlined />}
        title={t('home.install.androidLiveTitle')}
        description={t('home.install.androidLiveDescription')}
        onClick={() => {
          track('App Install Click', { platform: 'android', source: 'google-play' });
          window.open(ANDROID_PLAY_STORE_URL, '_blank', 'noopener,noreferrer');
        }}
      />
    );
  }

  return (
    <OnboardingCard
      icon={
        <Image
          src="/icon.svg"
          width={44}
          height={44}
          alt=""
          style={{ borderRadius: themeTokens.borderRadius.md, display: 'block' }}
        />
      }
      title={t('home.install.iosTitle')}
      description={t('home.install.iosDescription')}
      accent="none"
      onClick={() => {
        track('App Install Click', { platform: 'ios', source: 'app-store' });
        window.open(IOS_APP_STORE_URL, '_blank', 'noopener,noreferrer');
      }}
    />
  );
}

export default function HomePageContent({
  boardConfigs,
  initialPopularConfigs,
  initialRecentBeta = [],
}: HomePageContentProps) {
  const { t } = useTranslation('marketing');
  const { status } = useSession();
  const router = useLocaleRouter();
  const { activeSession } = usePersistentSession();
  const onboardingTour = useOnboardingTourOptional();
  const [seshDrawerOpen, setSeshDrawerOpen] = useState(false);
  const [findClimbersOpen, setFindClimbersOpen] = useState(false);
  const [createBoardOpen, setCreateBoardOpen] = useState(false);
  const [seshDrawerMounted, setSeshDrawerMounted] = useState(false);
  const [findClimbersMounted, setFindClimbersMounted] = useState(false);
  const [createBoardMounted, setCreateBoardMounted] = useState(false);
  const [installPlatform, setInstallPlatform] = useState<InstallPlatform>('unknown');

  useEffect(() => {
    let cancelled = false;
    const classifyWeb = () => (/Android/i.test(navigator.userAgent) ? 'android-web' : 'other-web');

    // App-store screenshot tests set this flag so the install CTA matches
    // what users see in the actual iOS build (i.e. nothing).
    if (
      typeof window !== 'undefined' &&
      // oxlint-disable-next-line no-restricted-globals -- e2e flag must be read synchronously during render
      sessionStorage.getItem('boardsesh:e2e-suppress-install-card') === '1'
    ) {
      setInstallPlatform('native');
      return;
    }

    if (isNativeApp()) {
      setInstallPlatform('native');
      return;
    }

    // UA heuristic says we're in a Capacitor WebView but the bridge hasn't
    // injected window.Capacitor yet. Wait for it before classifying as web,
    // otherwise native users get stuck with install CTAs.
    if (isCapacitorWebView()) {
      waitForCapacitor()
        .then((appeared) => {
          if (cancelled) return;
          setInstallPlatform(appeared && isNativeApp() ? 'native' : classifyWeb());
        })
        .catch(() => {
          if (!cancelled) setInstallPlatform(classifyWeb());
        });
      return () => {
        cancelled = true;
      };
    }

    setInstallPlatform(classifyWeb());
  }, []);

  useEffect(() => {
    if (seshDrawerOpen) setSeshDrawerMounted(true);
  }, [seshDrawerOpen]);

  useEffect(() => {
    const handler = () => {
      setSeshDrawerMounted(true);
      setSeshDrawerOpen(true);
    };
    window.addEventListener(TOUR_OPEN_START_SESH_EVENT, handler);
    return () => window.removeEventListener(TOUR_OPEN_START_SESH_EVENT, handler);
  }, []);

  useEffect(() => {
    if (findClimbersOpen) setFindClimbersMounted(true);
  }, [findClimbersOpen]);

  useEffect(() => {
    if (createBoardOpen) setCreateBoardMounted(true);
  }, [createBoardOpen]);

  const isAuthenticated = status === 'authenticated';

  const handleBoardClick = useCallback(
    (board: UserBoard) => {
      if (board.slug) {
        router.push(constructBoardSlugListUrl(board.slug, board.angle));
      }
    },
    [router],
  );

  const handleConfigClick = useCallback(
    (config: PopularBoardConfig) => {
      const angle = getDefaultAngleForBoard(config.boardType);
      if (config.layoutName && config.sizeName && config.setNames.length > 0) {
        router.push(
          constructClimbListWithSlugs(
            config.boardType,
            config.layoutName,
            config.sizeName,
            config.sizeDescription ?? undefined,
            config.setNames,
            angle,
          ),
        );
      } else {
        const setIds = config.setIds.join(',');
        const numericFallback = `/${config.boardType}/${config.layoutId}/${config.sizeId}/${setIds}/${angle}/list`;
        router.push(
          tryConstructSlugListUrl(config.boardType, config.layoutId, config.sizeId, config.setIds, angle) ??
            numericFallback,
        );
      }
    },
    [router],
  );

  const handleCustomClick = useCallback(() => {
    setCreateBoardOpen(true);
  }, []);

  const handleBoardCreated = useCallback(
    (url: string) => {
      setCreateBoardOpen(false);
      router.push(url);
    },
    [router],
  );

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
        pb: 'var(--bottom-bar-height)',
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
        {/* Hero: Start Climbing CTA */}
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
          {/* i18n-ignore-next-line -- brand name, not translated */}
          <Image src="/brand/icon-transparent.svg" width={130} height={130} alt="Boardsesh" priority />
          <Typography
            variant="h5"
            fontWeight={themeTokens.typography.fontWeight.bold}
            sx={{ color: 'var(--bs-text-brand-primary)' }}
          >
            {t('home.hero.title')}
          </Typography>
          <Typography variant="body1" sx={{ color: 'var(--bs-text-brand-muted)', maxWidth: 320 }}>
            {t('home.hero.subtitle')}
          </Typography>
          <Button
            variant="contained"
            size="large"
            startIcon={<PlayArrowRounded />}
            onClick={() => {
              if (activeSession) {
                let url: string;
                if (activeSession.boardPath.startsWith('/b/')) {
                  const segments = activeSession.boardPath.split('/');
                  url = constructBoardSlugListUrl(segments[2], activeSession.parsedParams.angle);
                } else {
                  url = activeSession.boardPath;
                }
                setClimbSessionCookie(activeSession.sessionId);
                router.push(url);
              } else {
                setSeshDrawerOpen(true);
              }
            }}
            sx={{
              mt: 1,
              borderRadius: `${themeTokens.borderRadius.full}px`,
              px: 4,
              py: 1.5,
              fontSize: themeTokens.typography.fontSize.lg,
              fontWeight: themeTokens.typography.fontWeight.semibold,
              textTransform: 'none',
              // Brand CTA — the Velvet violet fill with an amber spark glow
              // (Velvet's warm half on the hero). The scheme-aware fill clears
              // AA with white text in both modes. The global MUI Button override
              // adds a translateY(-1px) on hover; cancel it so the CTA stays
              // anchored under the warm glow.
              backgroundColor: 'var(--color-primary-fill)',
              color: 'var(--color-on-primary)',
              boxShadow: '0 6px 18px rgba(255, 138, 61, 0.35)',
              '&:hover': {
                backgroundColor: 'var(--color-primary-fill-hover)',
                boxShadow: '0 8px 22px rgba(255, 138, 61, 0.45)',
                transform: 'none',
              },
            }}
          >
            {activeSession ? t('home.hero.ctaContinue') : t('home.hero.ctaStart')}
          </Button>
        </Box>

        {/* Board Discovery - Find nearby + Custom + My boards + Popular configs */}
        <BoardDiscoveryScroll
          onBoardClick={handleBoardClick}
          onConfigClick={handleConfigClick}
          onCustomClick={handleCustomClick}
          initialPopularConfigs={initialPopularConfigs}
        />

        {/* Recent beta videos from across the community — sits high in the page
            so the community signal isn't buried under the onboarding stack */}
        <HomeRecentBetaSection initialRecentBeta={initialRecentBeta} />

        {/* Onboarding Cards */}
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: 1.5,
            width: '100%',
            maxWidth: 420,
            mx: 'auto',
          }}
        >
          <Typography
            variant="body2"
            fontWeight={themeTokens.typography.fontWeight.semibold}
            sx={{
              color: 'var(--neutral-400)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              fontSize: themeTokens.typography.fontSize.xs,
              px: 0.5,
            }}
          >
            {t('home.onboardingHeader')}
          </Typography>

          <InstallAppCard platform={installPlatform} />

          <OnboardingCard
            icon={<PlayCircleOutlineOutlined />}
            title={t('home.cards.tourTitle')}
            description={t('home.cards.tourDescription')}
            accent="v11"
            onClick={() => onboardingTour?.start()}
          />

          <OnboardingCard
            icon={<WarningAmberOutlined />}
            title={t('home.cards.auroraTitle')}
            description={t('home.cards.auroraDescription')}
            accent="v11"
            onClick={() => router.push('/aurora-migration')}
          />

          <OnboardingCard
            icon={<LocalOfferOutlined />}
            title={t('home.cards.playlistTitle')}
            description={t('home.cards.playlistDescription')}
            accent="v12"
            onClick={() => router.push('/playlists')}
          />

          <OnboardingCard
            icon={<BluetoothOutlined />}
            title={t('home.cards.bluetoothTitle')}
            description={t('home.cards.bluetoothDescription')}
            accent="v12"
            onClick={() => setSeshDrawerOpen(true)}
          />

          <OnboardingCard
            icon={<PeopleOutlined />}
            title={t('home.cards.crewTitle')}
            description={t('home.cards.crewDescription')}
            accent="v13"
            onClick={() => setFindClimbersOpen(true)}
          />

          <OnboardingCard
            icon={<DiscordIcon />}
            title={t('home.cards.discordTitle')}
            description={t('home.cards.discordDescription')}
            accent="v13"
            onClick={() => window.open('https://discord.gg/YXA8GsXfQK', '_blank', 'noopener,noreferrer')}
          />
        </Box>

        {/* Authenticated users: nudge to feed */}
        {isAuthenticated && (
          <Box sx={{ textAlign: 'center', py: 2 }}>
            <Typography variant="body2" sx={{ color: 'var(--neutral-400)', mb: 1 }}>
              {t('home.feed.callout')}
            </Typography>
            <Button variant="text" size="small" onClick={() => router.push('/feed')} sx={{ textTransform: 'none' }}>
              {t('home.feed.cta')}
            </Button>
          </Box>
        )}
      </Box>

      {seshDrawerMounted && (
        <StartSeshDrawer open={seshDrawerOpen} onClose={() => setSeshDrawerOpen(false)} boardConfigs={boardConfigs} />
      )}

      {findClimbersMounted && (
        <UnifiedSearchDrawer
          open={findClimbersOpen}
          onClose={() => setFindClimbersOpen(false)}
          defaultCategory="users"
        />
      )}

      {createBoardMounted && (
        <BoardSelectorDrawer
          open={createBoardOpen}
          onClose={() => setCreateBoardOpen(false)}
          boardConfigs={boardConfigs}
          placement="bottom"
          onBoardSelected={handleBoardCreated}
        />
      )}
    </Box>
  );
}
