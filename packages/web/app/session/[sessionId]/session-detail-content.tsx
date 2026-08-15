'use client';

import React, { useState, useCallback, useMemo } from 'react';
import IosShare from '@mui/icons-material/IosShare';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { shareWithFallback } from '@/app/lib/share-utils';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Avatar from '@mui/material/Avatar';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import ArrowBackOutlined from '@mui/icons-material/ArrowBackOutlined';
import PersonOutlined from '@mui/icons-material/PersonOutlined';
import ChatBubbleOutlineOutlined from '@mui/icons-material/ChatBubbleOutlineOutlined';
import DeleteOutlined from '@mui/icons-material/DeleteOutlined';
import LocaleLink from '@/app/components/i18n/locale-link';
import { useTranslation } from 'react-i18next';
import { useSession } from 'next-auth/react';
import type { SessionDetail, SessionDetailTick, SessionFeedParticipant } from '@boardsesh/shared-schema';
import VoteButton from '@/app/components/social/vote-button';
import CommentSection from '@/app/components/social/comment-section';
import { VoteSummaryProvider } from '@/app/components/social/vote-summary-context';
import StaticClimbList from '@/app/components/climb-list/static-climb-list';
import { useMyBoards } from '@/app/hooks/use-my-boards';
import { useBoardDetailsMap } from '@/app/hooks/use-board-details-map';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';

import { useSessionDetail } from '@/app/hooks/use-session-detail';
import { themeTokens } from '@/app/theme/theme-config';
import type { Climb, BoardDetails } from '@/app/lib/types';
import SessionOverviewPanel from './session-overview-panel';
import { generateSessionName } from '@/app/lib/session-utils';
import { ConfirmPopover } from '@/app/components/ui/confirm-popover';
import { useDeleteTick } from '@/app/hooks/use-delete-tick';

type SessionDetailContentProps = {
  session: SessionDetail | null;
  sessionId?: string;
  fallbackBoardDetails?: BoardDetails | null;
  afterParticipants?: React.ReactNode;
  /** Current board angle for display in the board preview */
  currentAngle?: number;
  /** Callback when user changes the angle via the angle selector */
  onAngleChange?: (angle: number) => void;
  /** User-facing name of the named board (e.g., "My Home Wall") */
  namedBoardName?: string;
};

function formatDate(isoString: string): string {
  return new Date(isoString).toLocaleDateString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function getStatusColor(status: string): 'success' | 'primary' | 'default' {
  if (status === 'flash') return 'success';
  if (status === 'send') return 'primary';
  return 'default';
}

type TFunc = (key: string, options?: Record<string, unknown>) => string;

function ordinalSuffix(n: number, t: TFunc): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return t('detail.ordinalDefault', { n });
  switch (n % 10) {
    case 1:
      return t('detail.ordinalFirst', { n });
    case 2:
      return t('detail.ordinalSecond', { n });
    case 3:
      return t('detail.ordinalThird', { n });
    default:
      return t('detail.ordinalDefault', { n });
  }
}

function formatAttemptText(tick: SessionDetailTick, t: TFunc): string | null {
  if (tick.status === 'flash') return null;

  const sessionAttempts = tick.attemptCount;
  const total = tick.totalAttempts;

  if (tick.status === 'send') {
    const parts = [t('detail.attemptOnNth', { ordinal: ordinalSuffix(sessionAttempts, t) })];
    if (total != null && total > sessionAttempts) {
      parts.push(t('detail.totalAttempts', { count: total }));
    }
    return parts.join(', ');
  }

  // attempt status
  const parts = [t('detail.attemptCount', { count: sessionAttempts })];
  if (total != null && total > sessionAttempts) {
    parts.push(t('detail.totalAttempts', { count: total }));
  }
  return parts.join(', ');
}

type SessionClimbRows = {
  /** Deduplicated climbs, in the order they were first ticked. */
  climbs: Climb[];
  /**
   * Climbs the catalog lookup missed — the tick arrives with no name, no
   * layout and no frames, so both the board and the name slug in a climb URL
   * would be invented. Their rows render without a link.
   */
  unknownClimbUuids: Set<string>;
};

/**
 * Convert session ticks to deduplicated Climb objects for use with StaticClimbList.
 * Keeps the first occurrence of each climbUuid.
 */
function convertSessionTicksToClimbs(ticks: SessionDetailTick[], unknownClimbLabel: string): SessionClimbRows {
  const seen = new Map<string, Climb>();
  const order: string[] = [];
  const unknownClimbUuids = new Set<string>();

  for (const tick of ticks) {
    if (seen.has(tick.climbUuid)) continue;

    order.push(tick.climbUuid);
    if (!tick.climbName) unknownClimbUuids.add(tick.climbUuid);

    seen.set(tick.climbUuid, {
      uuid: tick.climbUuid,
      name: tick.climbName || unknownClimbLabel,
      frames: tick.frames || '',
      angle: tick.angle,
      difficulty: tick.difficultyName || '',
      quality_average: tick.quality != null ? String(tick.quality) : '0',
      setter_username: tick.setterUsername || '',
      description: '',
      ascensionist_count: 0,
      stars: 0,
      difficulty_error: '0',
      benchmark_difficulty: tick.isBenchmark ? tick.difficultyName || null : null,
      mirrored: tick.isMirror,
      is_no_match: tick.isNoMatch,
      boardType: tick.boardType,
      layoutId: tick.layoutId ?? null,
    });
  }

  return { climbs: order.map((uuid) => seen.get(uuid)!), unknownClimbUuids };
}

/**
 * BoardDetails per climb, built from the board each tick was logged against.
 * The backend resolves that per tick (`renderBoard` — "each tick is drawn on
 * ITS climber's board, not the session owner's", session-feed.ts), so a sesh
 * two climbers logged on different walls links each row to the wall it was
 * climbed on instead of the layout's largest size. Ticks the backend couldn't
 * resolve a board for are left out and keep the layout default.
 */
function buildLoggedBoardDetails(ticks: SessionDetailTick[]): Record<string, BoardDetails> {
  const byClimb: Record<string, BoardDetails> = {};

  for (const tick of ticks) {
    const loggedBoard = tick.renderBoard;
    if (!loggedBoard || byClimb[tick.climbUuid]) continue;

    try {
      byClimb[tick.climbUuid] = getBoardDetailsForBoard({
        board_name: tick.boardType,
        layout_id: loggedBoard.layoutId,
        size_id: loggedBoard.sizeId,
        set_ids: loggedBoard.setIds,
      });
    } catch {
      // The static board tables don't carry this configuration — the layout
      // default from useBoardDetailsMap stands in.
    }
  }

  return byClimb;
}

/**
 * Build a map of climbUuid -> ticks for that climb, preserving order.
 */
function groupTicksByClimbUuid(ticks: SessionDetailTick[]): Map<string, SessionDetailTick[]> {
  const map = new Map<string, SessionDetailTick[]>();
  for (const tick of ticks) {
    const existing = map.get(tick.climbUuid);
    if (existing) {
      existing.push(tick);
    } else {
      map.set(tick.climbUuid, [tick]);
    }
  }
  return map;
}

function SessionTickItem({
  tick,
  isMultiUser,
  participant,
  currentUserId,
  onDelete,
  isDeleting,
}: {
  tick: SessionDetailTick;
  isMultiUser: boolean;
  participant: SessionFeedParticipant | null;
  currentUserId?: string;
  onDelete?: (uuid: string) => void;
  isDeleting?: boolean;
}) {
  const { t } = useTranslation('session');
  const [commentsOpen, setCommentsOpen] = useState(false);
  const attemptText = formatAttemptText(tick, t);

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 0.25,
        py: 0.25,
        borderTop: `1px solid ${themeTokens.neutral[100]}`,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
        {isMultiUser && (
          <>
            <Avatar src={participant?.avatarUrl ?? undefined} sx={{ width: 18, height: 18 }}>
              {!participant?.avatarUrl && <PersonOutlined sx={{ fontSize: 10 }} />}
            </Avatar>
            <Typography variant="caption" sx={{ minWidth: 0 }} noWrap>
              {participant?.displayName || t('detail.climberFallback')}
            </Typography>
          </>
        )}
        <Chip
          label={tick.status}
          size="small"
          color={getStatusColor(tick.status)}
          variant={tick.status === 'attempt' ? 'outlined' : 'filled'}
          sx={{
            height: 20,
            '& .MuiChip-label': { px: 0.75, fontSize: themeTokens.typography.fontSize.xs - 1 },
          }}
        />
        {attemptText && (
          <Typography variant="caption" color="text.secondary">
            {attemptText}
          </Typography>
        )}
        <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 0.25 }}>
          <VoteButton entityType="tick" entityId={tick.uuid} initialUpvotes={tick.upvotes} likeOnly />
          <IconButton
            size="small"
            onClick={() => setCommentsOpen((prev) => !prev)}
            sx={{ color: commentsOpen ? 'text.primary' : 'text.secondary' }}
          >
            <ChatBubbleOutlineOutlined fontSize="small" />
          </IconButton>
          {currentUserId && tick.userId === currentUserId && onDelete && (
            <ConfirmPopover
              title={t('detail.deleteAscent')}
              description={t('detail.deleteAscentConfirm')}
              onConfirm={() => onDelete(tick.uuid)}
              okText={t('detail.delete')}
              okButtonProps={{ color: 'error' }}
            >
              <IconButton size="small" disabled={isDeleting} sx={{ color: 'text.secondary' }}>
                <DeleteOutlined fontSize="small" />
              </IconButton>
            </ConfirmPopover>
          )}
        </Box>
      </Box>
      {tick.comment && (
        <Typography variant="caption" color="text.secondary" sx={{ pl: isMultiUser ? 3.5 : 0, minWidth: 0 }} noWrap>
          {tick.comment}
        </Typography>
      )}
      <Collapse in={commentsOpen} unmountOnExit>
        <Box sx={{ mt: 0.5 }}>
          <CommentSection entityType="tick" entityId={tick.uuid} title={t('detail.comments')} />
        </Box>
      </Collapse>
    </Box>
  );
}

export default function SessionDetailContent({
  session: initialSession,
  sessionId: sessionIdProp,
  fallbackBoardDetails = null,
  afterParticipants,
  currentAngle: _currentAngle,
  onAngleChange: _onAngleChange,
  namedBoardName: _namedBoardName,
}: SessionDetailContentProps) {
  const { t } = useTranslation('session');
  const { data: authSession } = useSession();
  const deleteTick = useDeleteTick();
  const { showMessage } = useSnackbar();

  const { session: hookSession } = useSessionDetail({
    sessionId: sessionIdProp ?? initialSession?.sessionId,
    initialData: initialSession,
  });

  const session = hookSession;

  const [sessionCommentsOpen, setSessionCommentsOpen] = useState(false);

  const { boards: myBoards } = useMyBoards(true);

  // Derive values from session with null-safe defaults so hooks below can run unconditionally.
  // The actual null check / early return happens after all hooks are called.
  const sessionId = session?.sessionId ?? '';
  const sessionName = session?.sessionName;
  const participants = session?.participants ?? [];
  const totalSends = session?.totalSends ?? 0;
  const totalFlashes = session?.totalFlashes ?? 0;
  const totalAttempts = session?.totalAttempts ?? 0;
  const tickCount = session?.tickCount ?? 0;
  const gradeDistribution = session?.gradeDistribution ?? [];
  const boardTypes = session?.boardTypes ?? [];
  const hardestGrade = session?.hardestGrade;
  const firstTickAt = session?.firstTickAt ?? '';
  const durationMinutes = session?.durationMinutes;
  const goal = session?.goal;
  const notes = session?.notes;
  const ticks = session?.ticks ?? [];
  const upvotes = session?.upvotes ?? 0;
  const downvotes = session?.downvotes ?? 0;
  const commentCount = session?.commentCount ?? 0;

  // Still read: the own-tick delete affordance is gated on it. Owner-only
  // writes (rename, recap) live in the app — see SessionEditSheet.
  const currentUserId = authSession?.user?.id;

  const isMultiUser = participants.length > 1;
  const displayName = sessionName || generateSessionName(firstTickAt, boardTypes);

  // Build a lookup from userId to participant info (memoized to avoid recreating on every render)
  const participantMap = useMemo(() => {
    const map = new Map<string, SessionFeedParticipant>();
    for (const p of participants) {
      map.set(p.userId, p);
    }
    return map;
  }, [participants]);

  // Convert ticks to Climb objects for StaticClimbList
  const unknownClimbLabel = t('detail.unknownClimb');
  const { climbs: sessionClimbs, unknownClimbUuids } = useMemo(
    () => convertSessionTicksToClimbs(ticks, unknownClimbLabel),
    [ticks, unknownClimbLabel],
  );

  // Group ticks by climb for rendering tick details below each climb
  const ticksByClimb = useMemo(() => groupTicksByClimbUuid(ticks), [ticks]);

  // Collect tick UUIDs for batch vote summary fetching
  const tickUuids = useMemo(() => ticks.map((t) => t.uuid), [ticks]);

  // Build per-climb BoardDetails for multi-board support. StaticClimbList has
  // no equivalent for the unsupported/upsized hints, so those are left unread.
  // This pass only knows the climb's board type and layout, so it lands on the
  // layout's largest size with every set — a guess the logged board below
  // overrides wherever the backend resolved one.
  const { boardDetailsByClimb: layoutDefaultBoardDetails, defaultBoardDetails } = useBoardDetailsMap(
    sessionClimbs,
    myBoards,
    null,
    null,
    boardTypes,
  );
  const loggedBoardDetails = useMemo(() => buildLoggedBoardDetails(ticks), [ticks]);
  const boardDetailsByClimb = useMemo(
    () => ({ ...layoutDefaultBoardDetails, ...loggedBoardDetails }),
    [layoutDefaultBoardDetails, loggedBoardDetails],
  );
  const effectiveBoardDetails = defaultBoardDetails ?? fallbackBoardDetails;

  const handleShare = useCallback(async () => {
    const shareUrl = `${window.location.origin}/session/${sessionId}`;
    const name = sessionName || t('detail.shareTitle');
    await shareWithFallback({
      url: shareUrl,
      title: name,
      text: t('detail.shareText'),
      trackingEvent: 'Session Shared',
      trackingProps: { sessionId },
      onClipboardSuccess: () => showMessage(t('detail.shareSuccess'), 'success'),
      onError: () => showMessage(t('detail.shareError'), 'error'),
    });
  }, [sessionId, sessionName, showMessage, t]);

  const handleDeleteTick = useCallback(
    (uuid: string) => {
      deleteTick.mutate(uuid);
    },
    [deleteTick],
  );

  // Render tick details below each climb item (per-user rows for multi-user, status/attempts for single-user)
  const renderTickDetails = useCallback(
    (climb: Climb) => {
      const climbTicks = ticksByClimb.get(climb.uuid);
      if (!climbTicks || climbTicks.length === 0) return null;

      return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, px: 2, pb: 1 }}>
          {climbTicks.map((tick) => {
            const participant = isMultiUser ? participantMap.get(tick.userId) : null;
            return (
              <SessionTickItem
                key={tick.uuid}
                tick={tick}
                isMultiUser={isMultiUser}
                participant={participant ?? null}
                currentUserId={currentUserId}
                onDelete={handleDeleteTick}
                isDeleting={deleteTick.isPending}
              />
            );
          })}
        </Box>
      );
    },
    [ticksByClimb, participantMap, isMultiUser, currentUserId, handleDeleteTick, deleteTick.isPending],
  );

  const noopLoadMore = useCallback(() => {}, []);

  if (!session) {
    return (
      <Box sx={{ p: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
          <IconButton component={LocaleLink} href="/">
            <ArrowBackOutlined />
          </IconButton>
          <Typography variant="h6">{t('detail.notFound.title')}</Typography>
        </Box>
        <Typography color="text.secondary">{t('detail.notFound.subtitle')}</Typography>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        minHeight: '100dvh',
        pb: '60px',
        pt: 'var(--global-header-height)',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 2,
          py: 1.5,
          borderBottom: `1px solid ${themeTokens.neutral[200]}`,
        }}
      >
        <IconButton component={LocaleLink} href="/" size="small">
          <ArrowBackOutlined />
        </IconButton>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h6" noWrap>
            {displayName}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {formatDate(firstTickAt)}
          </Typography>
        </Box>
        <IconButton size="small" onClick={handleShare} aria-label={t('detail.share')}>
          <IosShare fontSize="small" />
        </IconButton>
      </Box>

      <Box
        sx={{
          px: 2,
          py: 2,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        <SessionOverviewPanel
          totalSends={totalSends}
          totalFlashes={totalFlashes}
          totalAttempts={totalAttempts}
          tickCount={tickCount}
          gradeDistribution={gradeDistribution}
          boardTypes={boardTypes}
          hardestGrade={hardestGrade}
          durationMinutes={durationMinutes}
          goal={goal}
          notes={notes}
          afterParticipants={afterParticipants}
        />

        {/* Session-level social */}
        <Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <VoteButton
              entityType="session"
              entityId={sessionId}
              initialUpvotes={upvotes}
              initialDownvotes={downvotes}
              likeOnly
            />
            <IconButton
              size="small"
              data-testid="session-comment-toggle"
              onClick={() => setSessionCommentsOpen((prev) => !prev)}
              sx={{ color: sessionCommentsOpen ? 'text.primary' : 'text.secondary' }}
            >
              <ChatBubbleOutlineOutlined fontSize="small" />
              {commentCount > 0 && (
                <Typography
                  variant="caption"
                  component="span"
                  sx={{ ml: 0.5, color: 'inherit', userSelect: 'none', fontSize: 12 }}
                >
                  {commentCount}
                </Typography>
              )}
            </IconButton>
          </Box>
          <Collapse in={sessionCommentsOpen} unmountOnExit>
            <CommentSection entityType="session" entityId={sessionId} title={t('detail.comments')} />
          </Collapse>
        </Box>

        <Divider />

        {/* Climbs list */}
        <Typography variant="subtitle1" fontWeight={600}>
          {t('detail.climbsCount', { count: sessionClimbs.length })}
        </Typography>
      </Box>

      {effectiveBoardDetails && sessionClimbs.length > 0 && (
        <VoteSummaryProvider entityType="tick" entityIds={tickUuids}>
          <StaticClimbList
            boardDetails={effectiveBoardDetails}
            boardDetailsByClimb={boardDetailsByClimb}
            unlinkedClimbUuids={unknownClimbUuids}
            climbs={sessionClimbs}
            isFetching={false}
            hasMore={false}
            onLoadMore={noopLoadMore}
            hideEndMessage
            showBottomSpacer
            renderItemExtra={renderTickDetails}
          />
        </VoteSummaryProvider>
      )}
    </Box>
  );
}
