'use client';

import React, { useCallback, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import StopCircleOutlined from '@mui/icons-material/StopCircleOutlined';
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import IosShare from '@mui/icons-material/IosShare';
import QrCode2Outlined from '@mui/icons-material/QrCode2Outlined';
import IconButton from '@mui/material/IconButton';
import { QRCodeSVG } from 'qrcode.react';
import { useQuery } from '@tanstack/react-query';
import SwipeableDrawer from '@/app/components/swipeable-drawer/swipeable-drawer';
import drawerCss from '@/app/components/swipeable-drawer/swipeable-drawer.module.css';
import { useDrawerDragResize } from '@/app/hooks/use-drawer-drag-resize';
import BoardRenderer from '@/app/components/board-renderer/board-renderer';
import { usePersistentSession } from '@/app/components/persistent-session/persistent-session-context';
import { useQueueBridgeBoardInfo } from '@/app/components/queue-control/queue-bridge-context';
import { useRouter, usePathname } from 'next/navigation';
import { themeTokens } from '@/app/theme/theme-config';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useSessionTimer } from '@/app/hooks/use-session-timer';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { GET_SESSION_DETAIL, type GetSessionDetailQueryResponse } from '@/app/lib/graphql/operations/activity-feed';
import { clearClimbSessionCookie } from '@/app/lib/climb-session-cookie';
import { shareWithFallback } from '@/app/lib/share-utils';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import type { SessionDetail } from '@boardsesh/shared-schema';
import { generateSessionName } from '@/app/lib/session-utils';
import SessionDetailContent from '@/app/session/[sessionId]/session-detail-content';

const getShareUrl = (sessionId: string | null) => {
  try {
    if (!sessionId) return '';
    return `https://www.boardsesh.com/join/${sessionId}`;
  } catch {
    return '';
  }
};

/**
 * Non-URL payload used for the mock QR shown during the onboarding tour. If
 * a curious user scans it their reader just displays this text — nothing
 * navigates or gets indexed.
 */
const TOUR_SHARE_QR_PAYLOAD = 'boardsesh:onboarding-tour-preview';

type SeshSettingsDrawerProps = {
  open: boolean;
  onClose: () => void;
  onTransitionEnd?: (open: boolean) => void;
  /**
   * When set, the drawer renders from this mock SessionDetail instead of the
   * user's live session. Used by the onboarding tour to preview a populated
   * party session. Skips GraphQL, hides the stop/share controls, and bypasses
   * the "no active session" guard.
   */
  tourMockSession?: SessionDetail;
  /** Forces the embedded CollapsibleSection to show a specific section during the tour. */
  tourActiveSection?: 'invite' | 'activity' | 'analytics' | null;
};

export default function SeshSettingsDrawer({
  open,
  onClose,
  onTransitionEnd,
  tourMockSession,
  tourActiveSection,
}: SeshSettingsDrawerProps) {
  const { activeSession, session, users, deactivateSession, liveSessionStats } = usePersistentSession();
  const { boardDetails, angle } = useQueueBridgeBoardInfo();
  const { token: authToken } = useWsAuthToken();
  const router = useRouter();
  const pathname = usePathname();
  const sessionId = activeSession?.sessionId ?? null;
  const shareUrl = getShareUrl(sessionId);
  const { showMessage } = useSnackbar();
  const sessionBoardDetails = activeSession?.boardDetails ?? boardDetails;
  const [isStopped, setIsStopped] = useState(false);

  const { paperRef, dragHandlers } = useDrawerDragResize({
    open,
    onClose,
  });
  const lastSessionRef = useRef<SessionDetail | null>(null);

  const [showQr, setShowQr] = useState(false);

  const handleShareSession = useCallback(async () => {
    await shareWithFallback({
      url: shareUrl,
      title: 'Join my climbing session',
      text: 'Jump in and climb with me on Boardsesh',
      trackingEvent: 'Session Shared',
      trackingProps: { sessionId: sessionId ?? '' },
      onClipboardSuccess: () => showMessage('Link copied!', 'success'),
      onError: () => showMessage('Failed to share', 'error'),
    });
  }, [shareUrl, sessionId, showMessage]);

  const handleAngleChange = useCallback(
    (newAngle: number) => {
      if (!boardDetails || angle === undefined) return;

      // Replace the current angle in the URL with the new one
      // Same pattern as angle-selector.tsx — find by value, not position
      const pathSegments = pathname.split('/');
      const angleIndex = pathSegments.findIndex((segment) => segment === angle.toString());

      if (angleIndex !== -1) {
        pathSegments[angleIndex] = newAngle.toString();
        router.push(pathSegments.join('/'));
      }
    },
    [boardDetails, angle, pathname, router],
  );

  const handleStopSession = useCallback(() => {
    deactivateSession();
    clearClimbSessionCookie();
    setIsStopped(true);
  }, [deactivateSession]);

  const handleClose = useCallback(() => {
    setIsStopped(false);
    onClose();
  }, [onClose]);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['activeSessionDetail', sessionId],
    queryFn: async () => {
      const client = createGraphQLHttpClient(authToken);
      return client.request<GetSessionDetailQueryResponse>(GET_SESSION_DETAIL, { sessionId });
    },
    enabled: open && !!sessionId && !!authToken && !tourMockSession,
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
  }, [
    activeSession,
    sessionId,
    sessionDetail,
    session?.startedAt,
    session?.name,
    session?.goal,
    users,
    boardDetails?.board_name,
  ]);

  const sessionForView = useMemo<SessionDetail | null>(() => {
    const base = sessionDetail ?? fallbackSession;
    if (!base) return null;

    if (!mergedStats) return base;

    const mergedTicks = mergedStats.ticks;
    const firstTickAt = mergedTicks.length > 0 ? mergedTicks[mergedTicks.length - 1].climbedAt : base.firstTickAt;
    const lastTickAt = mergedTicks.length > 0 ? mergedTicks[0].climbedAt : base.lastTickAt;

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
  }, [sessionDetail, fallbackSession, mergedStats]);

  if (sessionForView) {
    lastSessionRef.current = sessionForView;
  }
  const displaySession = tourMockSession ?? sessionForView ?? lastSessionRef.current;

  const timerText = useSessionTimer(
    tourMockSession ? tourMockSession.firstTickAt : (session?.startedAt ?? displaySession?.firstTickAt),
  );

  const drawerTitle = displaySession
    ? displaySession.sessionName || generateSessionName(displaySession.firstTickAt, displaySession.boardTypes)
    : 'Session';

  const inviteContent = tourMockSession ? (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
          Share this link or QR code with your crew and they&apos;ll show up live.
        </Typography>
        <IconButton disabled aria-label="Share session link (preview)">
          <IosShare />
        </IconButton>
        <IconButton disabled aria-label="Show QR code (preview)">
          <QrCode2Outlined />
        </IconButton>
      </Box>
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 1 }}>
        <QRCodeSVG value={TOUR_SHARE_QR_PAYLOAD} size={140} aria-hidden />
      </Box>
    </Box>
  ) : !isStopped && shareUrl ? (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
          Get your crew in by sharing this link or scanning the QR code
        </Typography>
        <IconButton onClick={handleShareSession} aria-label="Share session link">
          <IosShare />
        </IconButton>
        <IconButton onClick={() => setShowQr((v) => !v)} aria-label={showQr ? 'Hide QR code' : 'Show QR code'}>
          <QrCode2Outlined color={showQr ? 'primary' : 'inherit'} />
        </IconButton>
      </Box>
      {showQr && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 1 }}>
          <QRCodeSVG value={shareUrl} size={180} />
        </Box>
      )}
    </Box>
  ) : undefined;

  if (!activeSession && !tourMockSession && !isStopped) return null;

  return (
    <SwipeableDrawer
      title={
        <div data-swipe-blocked="" {...dragHandlers} className={drawerCss.dragHeaderWrapper}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            {sessionBoardDetails && (
              <Box
                sx={{
                  width: 36,
                  flexShrink: 0,
                  borderRadius: '6px',
                  overflow: 'hidden',
                  background: 'var(--neutral-100)',
                  aspectRatio: '1',
                }}
              >
                <BoardRenderer boardDetails={sessionBoardDetails} mirrored={false} thumbnail fillHeight />
              </Box>
            )}
            <Typography
              variant="subtitle1"
              sx={{
                fontWeight: 600,
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {drawerTitle}
            </Typography>
            {timerText && (
              <Typography
                variant="body2"
                sx={{
                  fontFamily: 'monospace',
                  fontWeight: 600,
                  color: 'text.secondary',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
              >
                {timerText}
              </Typography>
            )}
            {!isStopped && !tourMockSession ? (
              <IconButton
                size="small"
                onClick={handleStopSession}
                aria-label="Stop session"
                sx={{
                  color: themeTokens.colors.error,
                  flexShrink: 0,
                }}
              >
                <StopCircleOutlined />
              </IconButton>
            ) : (
              <IconButton size="small" onClick={handleClose} aria-label="Dismiss" sx={{ flexShrink: 0 }}>
                <CloseOutlined />
              </IconButton>
            )}
          </Box>
        </div>
      }
      placement="bottom"
      height="60%"
      paperRef={paperRef}
      open={open}
      onClose={handleClose}
      onTransitionEnd={onTransitionEnd}
      swipeEnabled={false}
      styles={{
        wrapper: {
          width: '100%',
          touchAction: 'pan-y' as const,
          transition: 'height 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        },
        header: {
          paddingLeft: `${themeTokens.spacing[3]}px`,
          paddingRight: `${themeTokens.spacing[3]}px`,
        },
        body: { padding: `${themeTokens.spacing[2]}px 0` },
      }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pb: 2 }}>
        {isLoading && !displaySession && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={28} />
          </Box>
        )}

        {isError && (
          <Alert severity="warning" sx={{ mx: 1 }}>
            Couldn&apos;t load full session details. Live stats will continue when available.
          </Alert>
        )}

        {displaySession && (
          <SessionDetailContent
            key={displaySession.sessionId}
            session={displaySession}
            embedded
            fallbackBoardDetails={sessionBoardDetails}
            inviteContent={inviteContent}
            currentAngle={angle}
            onAngleChange={!isStopped && !tourMockSession ? handleAngleChange : undefined}
            namedBoardName={activeSession?.namedBoardName}
            tourActiveSection={tourActiveSection}
          />
        )}
      </Box>
    </SwipeableDrawer>
  );
}
