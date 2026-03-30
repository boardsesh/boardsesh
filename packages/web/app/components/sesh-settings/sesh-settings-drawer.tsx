'use client';

import React, { useCallback, useMemo, useRef } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import StopCircleOutlined from '@mui/icons-material/StopCircleOutlined';
import Divider from '@mui/material/Divider';
import { useQuery } from '@tanstack/react-query';
import SwipeableDrawer from '@/app/components/swipeable-drawer/swipeable-drawer';
import AngleSelector from '@/app/components/board-page/angle-selector';
import { usePersistentSession } from '@/app/components/persistent-session/persistent-session-context';
import { useQueueBridgeBoardInfo } from '@/app/components/queue-control/queue-bridge-context';
import { useRouter, usePathname } from 'next/navigation';
import { themeTokens } from '@/app/theme/theme-config';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  GET_SESSION_DETAIL,
  type GetSessionDetailQueryResponse,
} from '@/app/lib/graphql/operations/activity-feed';
import type { SessionDetail } from '@boardsesh/shared-schema';
import SessionDetailContent from '@/app/session/[sessionId]/session-detail-content';

interface SeshSettingsDrawerProps {
  open: boolean;
  onClose: () => void;
  tourMode?: boolean;
}

// Mock data for the guided tour - a busy Saturday session with a grade pyramid
function buildTourMockSession(): SessionDetail {
  const sessionStart = new Date();
  sessionStart.setMinutes(sessionStart.getMinutes() - 95);

  // Grade pyramid: V5(6), V6(5), V7(4), V8(3), V9(2), V10(1), V11(1), V12(1) = 23 sends
  const gradeDistribution = [
    { grade: 'V5', flash: 2, send: 4, attempt: 6 },
    { grade: 'V6', flash: 1, send: 4, attempt: 5 },
    { grade: 'V7', flash: 1, send: 3, attempt: 5 },
    { grade: 'V8', flash: 1, send: 2, attempt: 4 },
    { grade: 'V9', flash: 0, send: 2, attempt: 3 },
    { grade: 'V10', flash: 0, send: 1, attempt: 2 },
    { grade: 'V11', flash: 0, send: 1, attempt: 2 },
    { grade: 'V12', flash: 0, send: 1, attempt: 3 },
  ];

  // Build mock ticks spread across the session
  const climbNames = [
    'The Scoop', 'Galaxy Brain', 'Crimpy McFace', 'Sloper City',
    'Dynomite', 'Pinch Me', 'Compression Test', 'Moonwalk',
    'Undercling King', 'Toe Hook Special', 'Heel Hook Hero', 'The Roof Rider',
    'Power Endurance', 'Deadpoint Deluxe', 'The Mantle', 'Campus Master',
    'Volume Rider', 'Arete Affair', 'Slab Wizard', 'The Overhang',
    'Gaston Groove', 'Bicycle Crunch', 'Rose Move',
  ];

  const grades = [
    'V5', 'V5', 'V5', 'V5', 'V5', 'V5',
    'V6', 'V6', 'V6', 'V6', 'V6',
    'V7', 'V7', 'V7', 'V7',
    'V8', 'V8', 'V8',
    'V9', 'V9',
    'V10',
    'V11',
    'V12',
  ];

  const difficultyMap: Record<string, number> = {
    'V5': 17, 'V6': 18, 'V7': 19, 'V8': 20,
    'V9': 21, 'V10': 22, 'V11': 23, 'V12': 24,
  };

  const flashIndices = new Set([0, 2, 6, 11, 15]); // 5 flashes
  const mirrorIndices = new Set([3, 8, 14, 19]);
  const benchmarkIndices = new Set([1, 7, 12, 20]);
  const setters = ['alex_m', 'sarah_k', 'mike_t', 'jenny_l', 'pro_setter'];

  const ticks = grades.map((grade, i) => {
    const tickTime = new Date(sessionStart);
    tickTime.setMinutes(tickTime.getMinutes() + Math.floor((i / grades.length) * 95));

    const isFlash = flashIndices.has(i);
    return {
      uuid: `tour-tick-${i}`,
      userId: i % 3 === 0 ? 'tour-user-2' : i % 3 === 1 ? 'tour-user-3' : 'tour-user-1',
      climbUuid: `tour-climb-${i}`,
      climbName: climbNames[i],
      boardType: 'kilter',
      layoutId: 1,
      angle: 40,
      status: isFlash ? 'flash' : 'send',
      attemptCount: isFlash ? 1 : Math.ceil(Math.random() * 4) + 1,
      difficulty: difficultyMap[grade],
      difficultyName: grade,
      quality: Math.floor(Math.random() * 3) + 1,
      isMirror: mirrorIndices.has(i),
      isBenchmark: benchmarkIndices.has(i),
      comment: null,
      frames: null,
      setterUsername: setters[i % setters.length],
      climbedAt: tickTime.toISOString(),
      upvotes: 0,
      totalAttempts: null,
    };
  });

  // Reverse so most recent first
  ticks.reverse();

  return {
    sessionId: 'tour-mock-session',
    sessionType: 'party',
    sessionName: 'Saturday Proj Session',
    ownerUserId: 'tour-user-1',
    participants: [
      { userId: 'tour-user-1', displayName: 'You', avatarUrl: null, sends: 10, flashes: 2, attempts: 18 },
      { userId: 'tour-user-2', displayName: 'Alex', avatarUrl: null, sends: 8, flashes: 2, attempts: 16 },
      { userId: 'tour-user-3', displayName: 'Sarah', avatarUrl: null, sends: 5, flashes: 1, attempts: 14 },
    ],
    totalSends: 23,
    totalFlashes: 5,
    totalAttempts: 48,
    tickCount: 23,
    gradeDistribution,
    boardTypes: ['kilter'],
    hardestGrade: 'V12',
    firstTickAt: sessionStart.toISOString(),
    lastTickAt: new Date().toISOString(),
    durationMinutes: 95,
    goal: 'Send a V12',
    ticks,
    upvotes: 0,
    downvotes: 0,
    voteScore: 0,
    commentCount: 0,
  };
}

export default function SeshSettingsDrawer({ open, onClose, tourMode }: SeshSettingsDrawerProps) {
  const { activeSession, session, users, endSessionWithSummary, liveSessionStats } = usePersistentSession();
  const { boardDetails, angle } = useQueueBridgeBoardInfo();
  const { token: authToken } = useWsAuthToken();
  const router = useRouter();
  const pathname = usePathname();
  const sessionId = activeSession?.sessionId ?? null;

  const handleAngleChange = useCallback((newAngle: number) => {
    if (!boardDetails || angle === undefined) return;

    // Replace the current angle in the URL with the new one
    // Same pattern as angle-selector.tsx — find by value, not position
    const pathSegments = pathname.split('/');
    const angleIndex = pathSegments.findIndex((segment) => segment === angle.toString());

    if (angleIndex !== -1) {
      pathSegments[angleIndex] = newAngle.toString();
      router.push(pathSegments.join('/'));
    }
  }, [boardDetails, angle, pathname, router]);

  const handleStopSession = useCallback(() => {
    endSessionWithSummary();
    onClose();
  }, [endSessionWithSummary, onClose]);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['activeSessionDetail', sessionId],
    queryFn: async () => {
      const client = createGraphQLHttpClient(authToken);
      return client.request<GetSessionDetailQueryResponse>(GET_SESSION_DETAIL, { sessionId });
    },
    enabled: open && !tourMode && !!sessionId && !!authToken,
    staleTime: 5000,
    refetchOnWindowFocus: false,
  });

  const sessionDetail = data?.sessionDetail ?? null;
  const mergedStats = useMemo(() => {
    if (liveSessionStats?.sessionId !== sessionId) return null;
    return liveSessionStats;
  }, [liveSessionStats, sessionId]);

  // Capture a stable timestamp once when the active session first becomes
  // relevant, so that unrelated dep changes don't regenerate different values.
  const fallbackTimestampRef = useRef<string | null>(null);
  if (activeSession && sessionId && !fallbackTimestampRef.current) {
    fallbackTimestampRef.current = new Date().toISOString();
  }
  if (!activeSession || !sessionId) {
    fallbackTimestampRef.current = null;
  }

  // Build a placeholder SessionDetail from live context when the real
  // sessionDetail hasn't loaded yet (or isn't available at all).
  const fallbackSession = useMemo<SessionDetail | null>(() => {
    if (tourMode) return null;
    if (!activeSession || !sessionId) return null;
    if (sessionDetail) return null; // not needed when we have real data

    const stableNow = fallbackTimestampRef.current!;
    const fallbackFirstTick = session?.startedAt ?? stableNow;
    const fallbackDurationMinutes = session?.startedAt
      ? Math.max(0, Math.round((new Date(stableNow).getTime() - new Date(session.startedAt).getTime()) / 60000))
      : null;

    return {
      sessionId,
      sessionType: 'party',
      sessionName: session?.name || activeSession.sessionName || null,
      ownerUserId: null,
      participants: users.map((user) => ({
        userId: user.id,
        displayName: user.username,
        avatarUrl: user.avatarUrl,
        sends: 0,
        flashes: 0,
        attempts: 0,
      })),
      totalSends: 0,
      totalFlashes: 0,
      totalAttempts: 0,
      tickCount: 0,
      gradeDistribution: [],
      boardTypes: boardDetails?.board_name ? [boardDetails.board_name] : [],
      hardestGrade: null,
      firstTickAt: fallbackFirstTick,
      lastTickAt: stableNow,
      durationMinutes: fallbackDurationMinutes,
      goal: session?.goal ?? null,
      ticks: [],
      upvotes: 0,
      downvotes: 0,
      voteScore: 0,
      commentCount: 0,
    };
  }, [tourMode, activeSession, sessionId, sessionDetail, session?.startedAt, session?.name, session?.goal, users, boardDetails?.board_name]);

  // Tour mode mock data
  const tourMockSession = useMemo<SessionDetail | null>(() => {
    if (!tourMode) return null;
    return buildTourMockSession();
  }, [tourMode]);

  const sessionForView = useMemo<SessionDetail | null>(() => {
    if (tourMode) return tourMockSession;

    const base = sessionDetail ?? fallbackSession;
    if (!base) return null;

    if (!mergedStats) return base;

    const mergedTicks = mergedStats.ticks;
    const firstTickAt = mergedTicks.length > 0
      ? mergedTicks[mergedTicks.length - 1].climbedAt
      : base.firstTickAt;
    const lastTickAt = mergedTicks.length > 0
      ? mergedTicks[0].climbedAt
      : base.lastTickAt;

    return {
      ...base,
      participants: mergedStats.participants,
      totalSends: mergedStats.totalSends,
      totalFlashes: mergedStats.totalFlashes,
      totalAttempts: mergedStats.totalAttempts,
      tickCount: mergedStats.tickCount,
      gradeDistribution: mergedStats.gradeDistribution,
      boardTypes: mergedStats.boardTypes,
      hardestGrade: mergedStats.hardestGrade,
      durationMinutes: mergedStats.durationMinutes,
      goal: mergedStats.goal,
      firstTickAt,
      lastTickAt,
      ticks: mergedTicks,
    };
  }, [tourMode, tourMockSession, sessionDetail, fallbackSession, mergedStats]);

  // In tour mode, always render even without an active session
  if (!tourMode && !activeSession) return null;

  return (
    <SwipeableDrawer
      title="Session Overview"
      placement="top"
      open={open}
      onClose={onClose}
      fullHeight
      styles={{
        wrapper: { height: '100dvh' },
        body: { padding: 0, paddingBottom: 0 },
      }}
      footer={!tourMode ? (
        <Button
          variant="outlined"
          color="error"
          startIcon={<StopCircleOutlined />}
          onClick={handleStopSession}
          fullWidth
          sx={{
            borderColor: themeTokens.colors.error,
            color: themeTokens.colors.error,
            '&:hover': {
              borderColor: themeTokens.colors.error,
              backgroundColor: `${themeTokens.colors.error}10`,
            },
          }}
        >
          Stop Session
        </Button>
      ) : undefined}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pb: 2 }}>
        {!tourMode && isLoading && !sessionForView && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={28} />
          </Box>
        )}

        {!tourMode && isError && (
          <Alert severity="warning" sx={{ mx: 1 }}>
            Couldn&apos;t load full session details. Live stats will continue when available.
          </Alert>
        )}

        {sessionForView && (
          <SessionDetailContent
            key={`${sessionForView.sessionId}:${sessionForView.ticks.length}:${sessionForView.ticks[0]?.uuid ?? ''}`}
            session={sessionForView}
            embedded
            fallbackBoardDetails={boardDetails}
          />
        )}

        {!tourMode && (
          <>
            <Divider />

            {boardDetails && angle !== undefined && (
              <Box sx={{ px: 1 }}>
                <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
                  Angle
                </Typography>
                <AngleSelector
                  boardName={boardDetails.board_name}
                  boardDetails={boardDetails}
                  currentAngle={angle}
                  currentClimb={null}
                  onAngleChange={handleAngleChange}
                />
              </Box>
            )}
          </>
        )}
      </Box>
    </SwipeableDrawer>
  );
}
