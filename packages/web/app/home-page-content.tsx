'use client';

import React, { useState, useCallback, useRef } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardActionArea from '@mui/material/CardActionArea';
import Backdrop from '@mui/material/Backdrop';
import Paper from '@mui/material/Paper';
import PlayArrowRounded from '@mui/icons-material/PlayArrowRounded';
import PeopleOutlined from '@mui/icons-material/PeopleOutlined';
import BluetoothOutlined from '@mui/icons-material/BluetoothOutlined';
import LocalOfferOutlined from '@mui/icons-material/LocalOfferOutlined';
import WarningAmberOutlined from '@mui/icons-material/WarningAmberOutlined';
import ExploreOutlined from '@mui/icons-material/ExploreOutlined';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { themeTokens } from '@/app/theme/theme-config';
import StartSeshDrawer from '@/app/components/session-creation/start-sesh-drawer';
import UnifiedSearchDrawer from '@/app/components/search-drawer/unified-search-drawer';
import BoardScrollSection from '@/app/components/board-scroll/board-scroll-section';
import BoardScrollCard from '@/app/components/board-scroll/board-scroll-card';
import { setGuidedTourPending, clearGuidedTourPending } from '@/app/lib/onboarding-db';
import { useDiscoverBoards } from '@/app/hooks/use-discover-boards';
import { constructBoardSlugListUrl } from '@/app/lib/url-utils';
import type { BoardConfigData } from '@/app/lib/server-board-configs';
import type { UserBoard } from '@boardsesh/shared-schema';

interface HomePageContentProps {
  boardConfigs: BoardConfigData;
  isAuthenticatedSSR?: boolean;
}

interface OnboardingCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
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

export default function HomePageContent({ boardConfigs, isAuthenticatedSSR }: HomePageContentProps) {
  const { status } = useSession();
  const router = useRouter();
  const [seshDrawerOpen, setSeshDrawerOpen] = useState(false);
  const [findClimbersOpen, setFindClimbersOpen] = useState(false);
  const [tourIntroOpen, setTourIntroOpen] = useState(false);
  const tourTriggeredSeshDrawer = useRef(false);

  const isAuthenticated = status === 'authenticated' ? true : (status === 'loading' ? (isAuthenticatedSSR ?? false) : false);

  const { boards: discoverBoards, isLoading: isBoardsLoading } = useDiscoverBoards({ limit: 20 });

  const handleTakeTour = useCallback(() => {
    setTourIntroOpen(true);
  }, []);

  const handleTourIntroGotIt = useCallback(async () => {
    setTourIntroOpen(false);
    await setGuidedTourPending();
    tourTriggeredSeshDrawer.current = true;
    setSeshDrawerOpen(true);
  }, []);

  const handleBoardClick = useCallback((board: UserBoard) => {
    if (board.slug) {
      router.push(constructBoardSlugListUrl(board.slug, board.angle));
    }
  }, [router]);

  return (
    <Box sx={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', pb: '60px' }}>
      <Box
        component="main"
        sx={{
          flex: 1,
          px: 2,
          py: 2,
          pt: 'calc(var(--global-header-height) + 16px)',
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
            Ready to climb?
          </Typography>
          <Typography
            variant="body1"
            sx={{ color: 'var(--neutral-500)', maxWidth: 320 }}
          >
            Start a session to track your climbing, control LEDs, and invite friends.
          </Typography>
          <Button
            variant="contained"
            size="large"
            startIcon={<PlayArrowRounded />}
            onClick={() => setSeshDrawerOpen(true)}
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
            Start climbing
          </Button>
        </Box>

        {/* Board Discovery - horizontal scroll */}
        {(isBoardsLoading || discoverBoards.length > 0) && (
          <BoardScrollSection title="Boards near you" loading={isBoardsLoading}>
            {discoverBoards.map((board) => (
              <BoardScrollCard
                key={board.uuid}
                userBoard={board}
                onClick={() => handleBoardClick(board)}
              />
            ))}
          </BoardScrollSection>
        )}

        {/* Onboarding Cards */}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
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
            Get started
          </Typography>

          <OnboardingCard
            icon={<ExploreOutlined />}
            title="Take the tour"
            description="Learn how to use Boardsesh step by step"
            onClick={handleTakeTour}
          />

          <OnboardingCard
            icon={<WarningAmberOutlined />}
            title="Old Kilter app users"
            description="Migrate your data to Boardsesh before it's lost"
            onClick={() => router.push('/aurora-migration')}
          />

          <OnboardingCard
            icon={<PeopleOutlined />}
            title="Find climbers"
            description="Follow friends and see their sessions in your feed"
            onClick={() => setFindClimbersOpen(true)}
          />

          <OnboardingCard
            icon={<LocalOfferOutlined />}
            title="Create playlists"
            description="Organize climbs into collections for your sessions"
            onClick={() => router.push('/playlists')}
          />

          <OnboardingCard
            icon={<BluetoothOutlined />}
            title="Connect your board"
            description="Light up holds on your board via Bluetooth"
            onClick={() => setSeshDrawerOpen(true)}
          />
        </Box>

        {/* Authenticated users: nudge to feed */}
        {isAuthenticated && (
          <Box sx={{ textAlign: 'center', py: 2 }}>
            <Typography variant="body2" sx={{ color: 'var(--neutral-400)', mb: 1 }}>
              Looking for your activity feed?
            </Typography>
            <Button
              variant="text"
              size="small"
              onClick={() => router.push('/feed')}
              sx={{ textTransform: 'none' }}
            >
              Go to Feed
            </Button>
          </Box>
        )}
      </Box>

      <StartSeshDrawer
        open={seshDrawerOpen}
        onClose={() => {
          setSeshDrawerOpen(false);
          // If the tour triggered this drawer and user closed without creating a session,
          // clear the pending flag so the tour doesn't unexpectedly start on a board page
          if (tourTriggeredSeshDrawer.current) {
            tourTriggeredSeshDrawer.current = false;
            clearGuidedTourPending();
          }
        }}
        boardConfigs={boardConfigs}
      />

      <UnifiedSearchDrawer
        open={findClimbersOpen}
        onClose={() => setFindClimbersOpen(false)}
        defaultCategory="users"
      />

      {/* Tour intro overlay */}
      {tourIntroOpen && (
        <>
          <Backdrop
            open
            sx={{ zIndex: 1100, backgroundColor: 'rgba(0,0,0,0.5)' }}
            onClick={() => setTourIntroOpen(false)}
          />
          <Paper
            sx={{
              position: 'fixed',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              zIndex: 1101,
              p: 3,
              maxWidth: 320,
              borderRadius: 2,
              textAlign: 'center',
            }}
          >
            <ExploreOutlined sx={{ fontSize: 40, color: themeTokens.colors.primary, mb: 1 }} />
            <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>
              Welcome to the tour!
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
              Let&apos;s walk through how Boardsesh works. First, create your climbing session by selecting a board and tapping Sesh.
            </Typography>
            <Button
              variant="contained"
              onClick={handleTourIntroGotIt}
              sx={{ textTransform: 'none', borderRadius: `${themeTokens.borderRadius.full}px` }}
            >
              Let&apos;s go!
            </Button>
          </Paper>
        </>
      )}
    </Box>
  );
}
