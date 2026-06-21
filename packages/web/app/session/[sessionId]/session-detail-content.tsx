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
import { useLocaleRouter } from '@/app/lib/i18n/use-locale-router';
import { useTranslation } from 'react-i18next';
import { useSession } from 'next-auth/react';
import type {
  SessionDetail,
  SessionDetailTick,
  SessionFeedParticipant,
  SessionSummary,
} from '@boardsesh/shared-schema';
import VoteButton from '@/app/components/social/vote-button';
import CommentSection from '@/app/components/social/comment-section';
import { VoteSummaryProvider } from '@/app/components/social/vote-summary-context';
import ClimbsList from '@/app/components/board-page/climbs-list';
import { FavoritesProvider } from '@/app/components/climb-actions/favorites-batch-context';
import { PlaylistsProvider } from '@/app/components/climb-actions/playlists-batch-context';
import { useClimbActionsData } from '@/app/hooks/use-climb-actions-data';
import { useMyBoards } from '@/app/hooks/use-my-boards';
import { useBoardDetailsMap } from '@/app/hooks/use-board-details-map';
import { getDefaultAngleForBoard } from '@/app/lib/board-config-for-playlist';

import { useSessionDetail } from '@/app/hooks/use-session-detail';
import { themeTokens } from '@/app/theme/theme-config';
import type { Climb, BoardDetails } from '@/app/lib/types';
import SessionOverviewPanel, {
  buildSessionSummaryParts,
} from '@/app/components/session-details/session-overview-panel';
import CollapsibleSection, {
  type CollapsibleSectionConfig,
} from '@/app/components/collapsible-section/collapsible-section';
import { CssBarChart } from '@/app/components/charts/css-bar-chart';
import { buildSessionGradeBars, SESSION_GRADE_LEGEND } from '@/app/components/charts/session-grade-bars';
import { useGradeFormat } from '@/app/hooks/use-grade-format';
import { generateSessionName } from '@/app/lib/session-utils';
import { ConfirmPopover } from '@/app/components/ui/confirm-popover';
import { useDeleteTick } from '@/app/hooks/use-delete-tick';
import SaveToHealthKitButton from '@/app/components/healthkit/save-to-healthkit-button';
import { useOptionalQueueActions, useOptionalSessionData } from '@/app/components/graphql-queue';

type SessionDetailContentProps = {
  session: SessionDetail | null;
  sessionId?: string;
  embedded?: boolean;
  fallbackBoardDetails?: BoardDetails | null;
  afterParticipants?: React.ReactNode;
  /** Invite content to show as a collapsible pill when embedded */
  inviteContent?: React.ReactNode;
  /** Current board angle for display in the board preview */
  currentAngle?: number;
  /** Callback when user changes the angle via the angle selector */
  onAngleChange?: (angle: number) => void;
  /** User-facing name of the named board (e.g., "My Home Wall") */
  namedBoardName?: string;
  /**
   * When set, forces the CollapsibleSection to render with this key active
   * and disables user interaction with the section headers. Used by the
   * onboarding tour to guide the user through each section.
   */
  tourActiveSection?: 'invite' | 'activity' | 'analytics' | null;
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

/**
 * Convert session ticks to deduplicated Climb objects for use with ClimbsList.
 * Keeps the first occurrence of each climbUuid.
 */
function convertSessionTicksToClimbs(ticks: SessionDetailTick[], unknownClimbLabel: string): Climb[] {
  const seen = new Map<string, Climb>();
  const order: string[] = [];

  for (const tick of ticks) {
    if (seen.has(tick.climbUuid)) continue;

    order.push(tick.climbUuid);

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
      boardType: tick.boardType,
      layoutId: tick.layoutId ?? null,
    });
  }

  return order.map((uuid) => seen.get(uuid)!);
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
  embedded = false,
  fallbackBoardDetails = null,
  afterParticipants,
  inviteContent,
  currentAngle: _currentAngle,
  onAngleChange: _onAngleChange,
  namedBoardName: _namedBoardName,
  tourActiveSection,
}: SessionDetailContentProps) {
  const { t } = useTranslation('session');
  const { data: authSession } = useSession();
  const router = useLocaleRouter();
  const deleteTick = useDeleteTick();
  const { showMessage } = useSnackbar();
  const queueActions = useOptionalQueueActions();
  const optionalSessionData = useOptionalSessionData();
  const isPersistentSessionActive = !!optionalSessionData?.isPersistentSessionActive;

  const { session: hookSession } = useSessionDetail({
    sessionId: sessionIdProp ?? initialSession?.sessionId,
    initialData: initialSession,
    enabled: !embedded,
  });

  const session = embedded ? initialSession : hookSession;

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
  const ticks = session?.ticks ?? [];
  const upvotes = session?.upvotes ?? 0;
  const downvotes = session?.downvotes ?? 0;
  const commentCount = session?.commentCount ?? 0;

  const currentUserId = authSession?.user?.id;
  const isParticipant = currentUserId ? participants.some((p) => p.userId === currentUserId) : false;

  const isMultiUser = participants.length > 1;
  const displayName = sessionName || generateSessionName(firstTickAt, boardTypes);

  const lastTickAt = session?.lastTickAt ?? '';
  const healthKitSummary: SessionSummary | null =
    session && isParticipant
      ? {
          sessionId,
          totalSends,
          totalFlashes,
          totalAttempts,
          gradeDistribution: gradeDistribution.map((g) => ({
            grade: g.grade,
            count: (g.flash ?? 0) + (g.send ?? 0),
            flash: g.flash ?? 0,
            send: g.send ?? 0,
            attempt: g.attempt ?? 0,
          })),
          hardestClimb: null,
          participants: [],
          startedAt: firstTickAt,
          endedAt: lastTickAt,
          durationMinutes: durationMinutes ?? null,
          goal: goal ?? null,
        }
      : null;
  const healthKitBoardType = boardTypes[0] ?? '';

  // Build a lookup from userId to participant info (memoized to avoid recreating on every render)
  const participantMap = useMemo(() => {
    const map = new Map<string, SessionFeedParticipant>();
    for (const p of participants) {
      map.set(p.userId, p);
    }
    return map;
  }, [participants]);

  // Convert ticks to Climb objects for ClimbsList
  const unknownClimbLabel = t('detail.unknownClimb');
  const sessionClimbs = useMemo(
    () => convertSessionTicksToClimbs(ticks, unknownClimbLabel),
    [ticks, unknownClimbLabel],
  );

  // Group ticks by climb for rendering tick details below each climb
  const ticksByClimb = useMemo(() => groupTicksByClimbUuid(ticks), [ticks]);

  // Collect tick UUIDs for batch vote summary fetching
  const tickUuids = useMemo(() => ticks.map((t) => t.uuid), [ticks]);

  // Build per-climb BoardDetails for multi-board support
  const { boardDetailsByClimb, defaultBoardDetails, unsupportedClimbs, upsizedClimbs } = useBoardDetailsMap(
    sessionClimbs,
    myBoards,
    null,
    null,
    boardTypes,
  );
  const effectiveBoardDetails = defaultBoardDetails ?? fallbackBoardDetails;

  // Climb actions data for favorites/playlists — derive from actual climb data, fall back to session metadata
  const climbUuids = useMemo(() => sessionClimbs.map((c) => c.uuid), [sessionClimbs]);
  const firstClimb = sessionClimbs[0];
  const actionsBoardName = firstClimb?.boardType || boardTypes[0] || '';
  const actionsLayoutId = firstClimb?.layoutId ?? 1;
  const actionsAngle = firstClimb?.angle ?? getDefaultAngleForBoard(actionsBoardName);

  const { favoritesProviderProps, playlistsProviderProps } = useClimbActionsData({
    boardName: actionsBoardName,
    layoutId: actionsLayoutId,
    angle: actionsAngle,
    climbUuids,
  });

  // Set the climb as current (so it's sent to the board / shared with the
  // party session) and, when not embedded in a drawer, navigate to its detail
  // page. Embedded mode skips navigation so the drawer stays open.
  // setCurrentClimb returns null when board-compatibility validation fails
  // (a snackbar is already surfaced). In that case, skip navigation too — the
  // user shouldn't land on a climb page for a climb the board rejected.
  const navigateToClimb = useCallback(
    async (climb: Climb) => {
      try {
        if (queueActions && !isPersistentSessionActive) {
          // Solo: keep today's behavior — set as active so BLE sends the
          // climb to the board, and skip navigation when board-compat
          // validation fails (snackbar already surfaced).
          const result = await queueActions.setCurrentClimb(climb, { playlistSuggestionSource: null });
          if (result === null) return;
        }
        // Party: skip setCurrentClimb so we don't yank the wall away from
        // other party members. We still navigate to the climb's board page
        // (in non-embedded mode), where the party member can preview or
        // explicitly send via the lightbulb/Set Active path.
        if (embedded) return;
        const bt = climb.boardType;
        if (!bt) return;
        const params = new URLSearchParams({ boardType: bt, climbUuid: climb.uuid });
        const res = await fetch(`/api/internal/climb-redirect?${params}`);
        if (!res.ok) return;
        const { url } = await res.json();
        if (url) router.push(url);
      } catch (error) {
        console.error('Failed to navigate to climb:', error);
      }
    },
    [queueActions, embedded, router, isPersistentSessionActive],
  );

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

  const { formatGrade, loaded: gradeFormatLoaded } = useGradeFormat();

  // Compute grade distribution from ticks client-side. Ticks are the ground
  // truth during live sessions — the backend's gradeDistribution can lag behind.
  const effectiveGradeDistribution = useMemo(() => {
    if (ticks.length === 0) return gradeDistribution;

    const gradeMap = new Map<string, { flash: number; send: number; attempt: number }>();
    for (const tick of ticks) {
      const grade = tick.difficultyName ?? 'Ungraded';
      const entry = gradeMap.get(grade) ?? { flash: 0, send: 0, attempt: 0 };
      if (tick.status === 'flash') entry.flash++;
      else if (tick.status === 'send') entry.send++;
      else entry.attempt++;
      gradeMap.set(grade, entry);
    }

    return Array.from(gradeMap.entries()).map(([grade, counts]) => ({
      grade,
      ...counts,
    }));
  }, [gradeDistribution, ticks]);

  const gradeBars = useMemo(
    () => buildSessionGradeBars(effectiveGradeDistribution, formatGrade),
    [effectiveGradeDistribution, formatGrade],
  );

  // Build collapsible sections for embedded (drawer) mode
  const embeddedSections = useMemo((): CollapsibleSectionConfig[] => {
    if (!embedded) return [];

    const sections: CollapsibleSectionConfig[] = [];

    if (inviteContent) {
      sections.push({
        key: 'invite',
        label: t('detail.sections.invite'),
        title: t('detail.sections.inviteTitle'),
        defaultSummary: t('detail.sections.inviteSummary'),
        getSummary: () => [],
        content: inviteContent,
        defaultActive: true,
      });
    }

    sections.push({
      key: 'activity',
      label: t('detail.sections.activity'),
      title: t('detail.climbsLogged', { count: sessionClimbs.length }),
      defaultSummary: t('detail.noClimbsYet'),
      getSummary: () =>
        buildSessionSummaryParts(
          {
            totalFlashes,
            totalSends,
            totalAttempts,
            tickCount,
            hardestGrade,
            formatGrade: gradeFormatLoaded ? formatGrade : undefined,
          },
          t,
        ),
      flush: true,
      content:
        effectiveBoardDetails && sessionClimbs.length > 0 ? (
          <VoteSummaryProvider entityType="tick" entityIds={tickUuids}>
            <FavoritesProvider {...favoritesProviderProps}>
              <PlaylistsProvider {...playlistsProviderProps}>
                <ClimbsList
                  boardDetails={effectiveBoardDetails}
                  boardDetailsByClimb={boardDetailsByClimb}
                  unsupportedClimbs={unsupportedClimbs}
                  upsizedClimbs={upsizedClimbs}
                  climbs={sessionClimbs}
                  isFetching={false}
                  hasMore={false}
                  onClimbSelect={navigateToClimb}
                  onLoadMore={noopLoadMore}
                  hideEndMessage
                  renderItemExtra={renderTickDetails}
                />
              </PlaylistsProvider>
            </FavoritesProvider>
          </VoteSummaryProvider>
        ) : (
          <Typography variant="body2" color="text.secondary">
            {t('detail.noClimbsYet')}
          </Typography>
        ),
    });

    sections.push({
      key: 'analytics',
      label: t('detail.sections.analytics'),
      title: t('detail.gradeDistribution'),
      defaultSummary: t('detail.gradesClimbedThisSession'),
      getSummary: () => {
        if (effectiveGradeDistribution.length === 0) return [];
        const count = effectiveGradeDistribution.length;
        return [t('detail.gradesCount', { count })];
      },
      lazy: true,
      content:
        effectiveGradeDistribution.length > 0 ? (
          <Box>
            <CssBarChart
              bars={gradeBars}
              height={160}
              mobileHeight={120}
              gap={3}
              ariaLabel={t('detail.sessionGradeDistribution')}
            />
            <Box sx={{ display: 'flex', gap: 1.5, justifyContent: 'center', mt: 1 }}>
              {SESSION_GRADE_LEGEND.map((entry) => (
                <Box key={entry.label} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <Box sx={{ width: 10, height: 10, borderRadius: '2px', bgcolor: entry.color }} />
                  <Typography variant="caption" color="text.secondary">
                    {entry.label}
                  </Typography>
                </Box>
              ))}
            </Box>
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary">
            {t('detail.logSomeClimbs')}
          </Typography>
        ),
    });

    return sections;
  }, [
    embedded,
    inviteContent,
    sessionClimbs,
    totalFlashes,
    totalSends,
    totalAttempts,
    tickCount,
    hardestGrade,
    gradeFormatLoaded,
    formatGrade,
    effectiveBoardDetails,
    tickUuids,
    favoritesProviderProps,
    playlistsProviderProps,
    boardDetailsByClimb,
    unsupportedClimbs,
    upsizedClimbs,
    navigateToClimb,
    noopLoadMore,
    renderTickDetails,
    effectiveGradeDistribution,
    gradeBars,
  ]);

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
        minHeight: embedded ? 'auto' : '100dvh',
        pb: embedded ? 0 : '60px',
        pt: embedded ? 0 : 'var(--global-header-height)',
      }}
    >
      {!embedded && (
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
      )}

      <Box
        sx={{
          px: embedded ? { xs: 1, sm: 2 } : 2,
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
          afterParticipants={!embedded ? afterParticipants : undefined}
          compact={embedded}
        />

        {/* Collapsible pills for embedded (drawer) mode */}
        {embedded && embeddedSections.length > 0 && (
          <CollapsibleSection sections={embeddedSections} forcedActiveKey={tourActiveSection ?? undefined} />
        )}

        {/* Full layout for standalone page */}
        {!embedded && (
          <>
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
              {healthKitSummary && (
                <Box sx={{ mt: 1 }}>
                  <SaveToHealthKitButton
                    summary={healthKitSummary}
                    boardType={healthKitBoardType}
                    existingWorkoutId={session.healthKitWorkoutId}
                  />
                </Box>
              )}
            </Box>

            <Divider />

            {/* Climbs list */}
            <Typography variant="subtitle1" fontWeight={600}>
              {t('detail.climbsCount', { count: sessionClimbs.length })}
            </Typography>
          </>
        )}
      </Box>

      {!embedded && effectiveBoardDetails && sessionClimbs.length > 0 && (
        <VoteSummaryProvider entityType="tick" entityIds={tickUuids}>
          <FavoritesProvider {...favoritesProviderProps}>
            <PlaylistsProvider {...playlistsProviderProps}>
              <ClimbsList
                boardDetails={effectiveBoardDetails}
                boardDetailsByClimb={boardDetailsByClimb}
                unsupportedClimbs={unsupportedClimbs}
                upsizedClimbs={upsizedClimbs}
                climbs={sessionClimbs}
                isFetching={false}
                hasMore={false}
                onClimbSelect={navigateToClimb}
                onLoadMore={noopLoadMore}
                hideEndMessage
                showBottomSpacer
                renderItemExtra={renderTickDetails}
              />
            </PlaylistsProvider>
          </FavoritesProvider>
        </VoteSummaryProvider>
      )}
    </Box>
  );
}
