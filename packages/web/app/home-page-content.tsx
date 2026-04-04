'use client';

import React, { useState, useCallback, useEffect } from 'react';
import dynamic from 'next/dynamic';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardActionArea from '@mui/material/CardActionArea';
import PlayArrowRounded from '@mui/icons-material/PlayArrowRounded';
import PeopleOutlined from '@mui/icons-material/PeopleOutlined';
import BluetoothOutlined from '@mui/icons-material/BluetoothOutlined';
import LocalOfferOutlined from '@mui/icons-material/LocalOfferOutlined';
import WarningAmberOutlined from '@mui/icons-material/WarningAmberOutlined';
import SvgIcon from '@mui/material/SvgIcon';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { themeTokens } from '@/app/theme/theme-config';
import { usePersistentSession } from '@/app/components/persistent-session';
import BoardScrollSection from '@/app/components/board-scroll/board-scroll-section';
import BoardScrollCard from '@/app/components/board-scroll/board-scroll-card';
import FindNearbyCard, { type FindNearbyStatus } from '@/app/components/board-scroll/find-nearby-card';
import { useDiscoverBoards } from '@/app/hooks/use-discover-boards';
import { usePopularBoardConfigs } from '@/app/hooks/use-popular-board-configs';
import { constructBoardSlugListUrl, constructClimbListWithSlugs, tryConstructSlugListUrl } from '@/app/lib/url-utils';
import { getDefaultAngleForBoard } from '@/app/lib/board-config-for-playlist';
import type { BoardConfigData } from '@/app/lib/server-board-configs';
import type { UserBoard, PopularBoardConfig } from '@boardsesh/shared-schema';
import { setClimbSessionCookie } from '@/app/lib/climb-session-cookie';

function deriveFindNearbyStatus({
  locationEnabled,
  isLoading,
  error,
  hasLocation,
}: {
  locationEnabled: boolean;
  isLoading: boolean;
  error: string | null;
  hasLocation: boolean;
}): FindNearbyStatus {
  if (!locationEnabled) return 'idle';
  if (isLoading) return 'loading';
  if (error) return 'error';
  if (!hasLocation) return 'geo-denied';
  return 'no-results';
}

const StartSeshDrawer = dynamic(
  () => import('@/app/components/session-creation/start-sesh-drawer'),
  { ssr: false },
);

const UnifiedSearchDrawer = dynamic(
  () => import('@/app/components/search-drawer/unified-search-drawer'),
  { ssr: false },
);

interface HomePageContentProps {
  boardConfigs: BoardConfigData;
  initialPopularConfigs?: PopularBoardConfig[];
}

interface OnboardingCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}

function DiscordIcon() {
  return (
    <SvgIcon viewBox="0 -28.5 256 256">
      <path d="M216.856 16.597A208.502 208.502 0 0 0 164.042 0c-2.275 4.113-4.933 9.645-6.766 14.046-19.692-2.961-39.203-2.961-58.533 0-1.832-4.4-4.55-9.933-6.846-14.046a207.809 207.809 0 0 0-52.855 16.638C5.618 67.147-3.443 116.4 1.087 164.956c22.169 16.555 43.653 26.612 64.775 33.193a161.094 161.094 0 0 0 13.882-22.584 136.428 136.428 0 0 1-21.846-10.632 108.636 108.636 0 0 0 5.356-4.237c42.122 19.702 87.89 19.702 129.51 0a131.66 131.66 0 0 0 5.355 4.237 136.07 136.07 0 0 1-21.886 10.653c4.006 8.02 8.638 15.67 13.862 22.564 21.142-6.58 42.646-16.637 64.815-33.213 5.316-56.288-9.08-105.09-38.056-148.36ZM85.474 135.095c-12.645 0-23.015-11.805-23.015-26.18s10.149-26.2 23.015-26.2c12.867 0 23.236 11.804 23.015 26.2.02 14.375-10.148 26.18-23.015 26.18Zm85.051 0c-12.645 0-23.014-11.805-23.014-26.18s10.148-26.2 23.014-26.2c12.867 0 23.236 11.804 23.015 26.2 0 14.375-10.148 26.18-23.015 26.18Z" />
    </SvgIcon>
  );
}

function OnboardingCard({ icon, title, description, onClick }: OnboardingCardProps) {
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
              backgroundColor: 'var(--semantic-selected-light)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              color: themeTokens.colors.primary,
            }}
          >
            {icon}
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography
              variant="body1"
              fontWeight={themeTokens.typography.fontWeight.semibold}
              sx={{ color: 'var(--neutral-900)', lineHeight: themeTokens.typography.lineHeight.tight }}
            >
              {title}
            </Typography>
            <Typography
              variant="body2"
              sx={{ color: 'var(--neutral-500)', mt: 0.25 }}
            >
              {description}
            </Typography>
          </Box>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}

export default function HomePageContent({ boardConfigs, initialPopularConfigs }: HomePageContentProps) {
  const { status } = useSession();
  const router = useRouter();
  const { activeSession } = usePersistentSession();
  const [seshDrawerOpen, setSeshDrawerOpen] = useState(false);
  const [findClimbersOpen, setFindClimbersOpen] = useState(false);
  const [seshDrawerMounted, setSeshDrawerMounted] = useState(false);
  const [findClimbersMounted, setFindClimbersMounted] = useState(false);

  useEffect(() => {
    if (seshDrawerOpen) setSeshDrawerMounted(true);
  }, [seshDrawerOpen]);

  useEffect(() => {
    if (findClimbersOpen) setFindClimbersMounted(true);
  }, [findClimbersOpen]);

  const isAuthenticated = status === 'authenticated';

  const [locationEnabled, setLocationEnabled] = useState(false);
  const { boards: discoverBoards, isLoading: isBoardsLoading, hasLocation, error: discoverError } = useDiscoverBoards({ limit: 20, enableLocation: locationEnabled });
  const { configs: popularConfigs, isLoading: isConfigsLoading, isLoadingMore, hasMore, loadMore } = usePopularBoardConfigs({ limit: 12, initialData: initialPopularConfigs });

  const handleBoardClick = useCallback((board: UserBoard) => {
    if (board.slug) {
      router.push(constructBoardSlugListUrl(board.slug, board.angle));
    }
  }, [router]);

  const handleConfigClick = useCallback((config: PopularBoardConfig) => {
    const angle = getDefaultAngleForBoard(config.boardType);
    if (config.layoutName && config.sizeName && config.setNames.length > 0) {
      router.push(constructClimbListWithSlugs(
        config.boardType,
        config.layoutName,
        config.sizeName,
        config.sizeDescription ?? undefined,
        config.setNames,
        angle,
      ));
    } else {
      const setIds = config.setIds.join(',');
      const numericFallback = `/${config.boardType}/${config.layoutId}/${config.sizeId}/${setIds}/${angle}/list`;
      router.push(
        tryConstructSlugListUrl(config.boardType, config.layoutId, config.sizeId, config.setIds, angle)
          ?? numericFallback,
      );
    }
  }, [router]);

  return (
    <Box sx={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', pb: 'calc(120px + env(safe-area-inset-bottom, 0px))' }}>
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
            py: 4,
          }}
        >
          <Typography
            variant="h5"
            fontWeight={themeTokens.typography.fontWeight.bold}
            sx={{ color: 'var(--neutral-900)' }}
          >
            Get on the board!
          </Typography>
          <Typography
            variant="body1"
            sx={{ color: 'var(--neutral-500)', maxWidth: 320 }}
          >
            Track your sends across Kilter, Tension, and MoonBoard.
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
                  // Legacy/custom path — navigate directly
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
              boxShadow: themeTokens.shadows.md,
            }}
          >
            {activeSession ? 'Continue climbing' : 'Start climbing'}
          </Button>
        </Box>

        {/* Board Discovery - horizontal scroll */}
        {(isBoardsLoading || isConfigsLoading || discoverBoards.length > 0 || popularConfigs.length > 0) && (
          <BoardScrollSection
            title="Boards near you"
            loading={isBoardsLoading && popularConfigs.length === 0}
            onLoadMore={loadMore}
            hasMore={hasMore}
            isLoadingMore={isLoadingMore}
          >
            {discoverBoards.length === 0 && (
              <FindNearbyCard
                onClick={() => setLocationEnabled(true)}
                status={deriveFindNearbyStatus({
                  locationEnabled,
                  isLoading: isBoardsLoading,
                  error: discoverError,
                  hasLocation,
                })}
              />
            )}
            {discoverBoards.map((board) => (
              <BoardScrollCard
                key={board.uuid}
                userBoard={board}
                onClick={() => handleBoardClick(board)}
              />
            ))}
            {popularConfigs.map((config) => (
              <BoardScrollCard
                key={`${config.boardType}-${config.layoutId}-${config.sizeId}`}
                popularConfig={config}
                onClick={() => handleConfigClick(config)}
              />
            ))}
          </BoardScrollSection>
        )}

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
            Make it yours
          </Typography>

          <OnboardingCard
            icon={<WarningAmberOutlined />}
            title="Coming from Kilter?"
            description="Bring your logbook and history over in one step"
            onClick={() => router.push('/aurora-migration')}
          />

          <OnboardingCard
            icon={<PeopleOutlined />}
            title="Find your crew"
            description="Follow friends and see what they're climbing"
            onClick={() => setFindClimbersOpen(true)}
          />

          <OnboardingCard
            icon={<LocalOfferOutlined />}
            title="Build a playlist"
            description="Line up your climbs before you get to the gym"
            onClick={() => router.push('/playlists')}
          />

          <OnboardingCard
            icon={<BluetoothOutlined />}
            title="Connect your board"
            description="Pair via Bluetooth and light up your next climb"
            onClick={() => setSeshDrawerOpen(true)}
          />

          <OnboardingCard
            icon={<DiscordIcon />}
            title="Join the crew on Discord"
            description="Share beta, report bugs, and help shape what's next"
            onClick={() => window.open('https://discord.gg/YXA8GsXfQK', '_blank', 'noopener,noreferrer')}
          />
        </Box>

        {/* Authenticated users: nudge to feed */}
        {isAuthenticated && (
          <Box sx={{ textAlign: 'center', py: 2 }}>
            <Typography variant="body2" sx={{ color: 'var(--neutral-400)', mb: 1 }}>
              Your friends are climbing.
            </Typography>
            <Button
              variant="text"
              size="small"
              onClick={() => router.push('/feed')}
              sx={{ textTransform: 'none' }}
            >
              See the feed
            </Button>
          </Box>
        )}
      </Box>

      {seshDrawerMounted && (
        <StartSeshDrawer
          open={seshDrawerOpen}
          onClose={() => setSeshDrawerOpen(false)}
          boardConfigs={boardConfigs}
        />
      )}

      {findClimbersMounted && (
        <UnifiedSearchDrawer
          open={findClimbersOpen}
          onClose={() => setFindClimbersOpen(false)}
          defaultCategory="users"
        />
      )}
    </Box>
  );
}
