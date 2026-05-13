'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import Divider from '@mui/material/Divider';
import StopCircleOutlined from '@mui/icons-material/StopCircleOutlined';
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import IosShare from '@mui/icons-material/IosShare';
import QrCode2Outlined from '@mui/icons-material/QrCode2Outlined';
import IconButton from '@mui/material/IconButton';
import { QRCodeSVG } from 'qrcode.react';
import SwipeableDrawer from '@/app/components/swipeable-drawer/swipeable-drawer';
import drawerCss from '@/app/components/swipeable-drawer/swipeable-drawer.module.css';
import { useDrawerDragResize } from '@/app/hooks/use-drawer-drag-resize';
import BoardRenderer from '@/app/components/board-renderer/board-renderer';
import { usePersistentSession } from '@/app/components/persistent-session/persistent-session-context';
import { useQueueBridgeBoardInfo } from '@/app/components/queue-control/queue-bridge-context';
import { usePathname } from 'next/navigation';
import { useLocaleRouter } from '@/app/lib/i18n/use-locale-router';
import { useTranslation } from 'react-i18next';
import { themeTokens } from '@/app/theme/theme-config';
import { useSessionTimer } from '@/app/hooks/use-session-timer';
import { useSessionDetail } from '@/app/hooks/use-session-detail';
import { clearClimbSessionCookie } from '@/app/lib/climb-session-cookie';
import { shareWithFallback } from '@/app/lib/share-utils';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import type { SessionDetail } from '@boardsesh/shared-schema';
import { generateSessionName } from '@/app/lib/session-utils';
import SessionDetailContent from '@/app/session/[sessionId]/session-detail-content';
import ObsRecorderPanel from './obs-recorder-panel';

const getShareUrl = (sessionId: string | null) => {
  try {
    if (!sessionId) return '';
    return `${window.location.origin}/join/${sessionId}`;
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
  const { t } = useTranslation('session');
  const { activeSession, session, users, deactivateSession, currentClimbQueueItem } = usePersistentSession();
  const { boardDetails, angle } = useQueueBridgeBoardInfo();
  const router = useLocaleRouter();
  const pathname = usePathname();
  const sessionId = activeSession?.sessionId ?? null;
  const shareUrl = getShareUrl(sessionId);
  const { showMessage } = useSnackbar();
  const sessionBoardDetails = activeSession?.boardDetails ?? boardDetails;
  const [isStopped, setIsStopped] = useState(false);
  const [obsRecordingActive, setObsRecordingActive] = useState(false);

  const { paperRef, dragHandlers } = useDrawerDragResize({
    open,
    onClose,
  });
  const lastSessionRef = useRef<SessionDetail | null>(null);

  const [showQr, setShowQr] = useState(false);

  const handleShareSession = useCallback(async () => {
    await shareWithFallback({
      url: shareUrl,
      title: t('settings.share.shareTitle'),
      text: t('settings.share.shareText'),
      trackingEvent: 'Session Shared',
      trackingProps: { sessionId: sessionId ?? '' },
      onClipboardSuccess: () => showMessage(t('settings.share.linkCopied'), 'success'),
      onError: () => showMessage(t('settings.share.shareError'), 'error'),
    });
  }, [shareUrl, sessionId, showMessage, t]);

  const handleAngleChange = useCallback(
    (newAngle: number) => {
      if (!boardDetails || angle === undefined) return;

      // Replace the current angle in the URL with the new one
      // Same pattern as angle-selector.tsx — find by value, not position
      const pathSegments = pathname.split('/');
      const angleIndex = pathSegments.findIndex((segment) => segment === angle.toString());

      if (angleIndex !== -1) {
        pathSegments[angleIndex] = newAngle.toString();
        let newPath = pathSegments.join('/');
        // Read live query string from window.location so filter state
        // (mirrored to the URL via history.replaceState in QueueContext) is
        // preserved across the angle change.
        const queryString = window.location.search.slice(1);
        if (queryString) {
          newPath = `${newPath}?${queryString}`;
        }
        router.push(newPath);
      }
    },
    [boardDetails, angle, pathname, router],
  );

  const handleStopSession = useCallback(() => {
    if (obsRecordingActive) {
      showMessage(t('settings.recorder.stopRecordingBeforeSessionEnd'), 'warning');
      return;
    }

    deactivateSession();
    clearClimbSessionCookie();
    setIsStopped(true);
  }, [deactivateSession, obsRecordingActive, showMessage, t]);

  const handleClose = useCallback(() => {
    setIsStopped(false);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!activeSession) {
      setObsRecordingActive(false);
    }
  }, [activeSession]);

  const {
    session: sessionDetail,
    isLoading,
    isError,
  } = useSessionDetail({
    sessionId: sessionId ?? undefined,
    enabled: open && !!sessionId && !tourMockSession,
  });

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

  const sessionForView = sessionDetail ?? fallbackSession;

  if (sessionForView) {
    lastSessionRef.current = sessionForView;
  }
  const displaySession = tourMockSession ?? sessionForView ?? lastSessionRef.current;

  const timerText = useSessionTimer(
    tourMockSession ? tourMockSession.firstTickAt : (session?.startedAt ?? displaySession?.firstTickAt),
  );

  const drawerTitle = displaySession
    ? displaySession.sessionName || generateSessionName(displaySession.firstTickAt, displaySession.boardTypes)
    : t('settings.fallbackTitle');

  const recorderContent =
    tourMockSession || !activeSession || isStopped ? null : (
      <ObsRecorderPanel currentClimbQueueItem={currentClimbQueueItem} onRecordingActiveChange={setObsRecordingActive} />
    );

  let inviteContent: React.ReactNode;
  if (tourMockSession) {
    inviteContent = (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
            {t('settings.share.inviteCopyPreview')}
          </Typography>
          <IconButton disabled aria-label={t('settings.share.shareLinkPreview')}>
            <IosShare />
          </IconButton>
          <IconButton disabled aria-label={t('settings.share.showQrPreview')}>
            <QrCode2Outlined />
          </IconButton>
        </Box>
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 1 }}>
          <QRCodeSVG value={TOUR_SHARE_QR_PAYLOAD} size={140} level="M" marginSize={4} aria-hidden />
        </Box>
      </Box>
    );
  } else if (!isStopped && shareUrl) {
    inviteContent = (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
            {t('settings.share.inviteCopy')}
          </Typography>
          <IconButton onClick={handleShareSession} aria-label={t('settings.share.shareLink')}>
            <IosShare />
          </IconButton>
          <IconButton
            onClick={() => setShowQr((v) => !v)}
            aria-label={showQr ? t('settings.share.hideQr') : t('settings.share.showQr')}
          >
            <QrCode2Outlined color={showQr ? 'primary' : 'inherit'} />
          </IconButton>
        </Box>
        {showQr && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 1 }}>
            <QRCodeSVG value={shareUrl} size={180} level="M" marginSize={4} />
          </Box>
        )}
      </Box>
    );
  } else {
    inviteContent = undefined;
  }

  if (recorderContent) {
    inviteContent = inviteContent ? (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        {inviteContent}
        <Divider />
        {recorderContent}
      </Box>
    ) : (
      recorderContent
    );
  }

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
                aria-label={t('settings.stopSession')}
                sx={{
                  color: themeTokens.colors.error,
                  flexShrink: 0,
                }}
              >
                <StopCircleOutlined />
              </IconButton>
            ) : (
              <IconButton size="small" onClick={handleClose} aria-label={t('settings.dismiss')} sx={{ flexShrink: 0 }}>
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
            {t('settings.loadFailed')}
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
