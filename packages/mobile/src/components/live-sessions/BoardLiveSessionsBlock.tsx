// "Climbing here now" in the board sheet: live sessions on the wall the climber
// is standing at. Self-subscribing and memoised so the panel's list header only
// rebuilds on the board id and who holds the board, not on every poll of this
// query.

import { memo, useCallback, useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { Avatar } from '../Avatar';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { AvatarGroup } from '../you/AvatarGroup';
import { track } from '../../lib/analytics';
import { hapticLight } from '../../lib/haptics';
import { useIsAppBackgrounded } from '../../lib/app-visibility';
import { useBoardLiveSessions } from '../../lib/graphql/hooks/use-live-sessions';
import { useProfile } from '../../lib/graphql/hooks';
import { useOfflineQueryState } from '../../hooks/use-offline-query-state';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { useQueueSessionId } from '../../providers/queue-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { useLivePulseDriver } from './LiveDot';
import { LiveActionPill, LiveGradeChip, LiveStatusDot } from './LiveBadges';
import { startedAtKeyFor, useElapsedClock } from './use-elapsed-clock';
import { useLiveSessionColors } from './use-live-session-colors';
import {
  countLiveNow,
  describeLiveNames,
  elapsedParts,
  isQuietSession,
  type LiveCardModel,
} from './live-session-model';
import { elapsedShort, liveNamesCopy, startedSpoken } from './live-session-copy';

/** Rows shown before "N more". A capped `.map`, so no list virtualization needed. */
export const BOARD_LIVE_SESSIONS_MAX_ROWS = 3;
const EMPTY_CARDS: LiveCardModel[] = [];
const ROW_AVATAR_SIZE = 32;
const ACTION_HEIGHT = 44;

export type BoardLiveSessionsBlockProps = {
  /** The board-presence board id; null renders nothing. */
  boardId: number | null;
  /** Who is connected to the board right now, when the sheet knows. */
  holderName: string | null;
  holderUserId: string | null;
  /**
   * Close the sheet and wait for it to settle before routing away: pushing the
   * native /join modal mid-dismiss is the handoff docs/mobile-sheets-vs-routes.md
   * warns about. Resolves false when the handoff was aborted.
   */
  onBeforeNavigate?: () => Promise<boolean>;
};

type RowProps = {
  card: LiveCardModel;
  nowMs: number;
  viewerUserId: string | null;
  formatGrade: (grade: string | null | undefined) => string | null;
  onPress: (card: LiveCardModel) => void;
};

const BoardLiveSessionRow = memo(function BoardLiveSessionRow({
  card,
  nowMs,
  viewerUserId,
  formatGrade,
  onPress,
}: RowProps) {
  const { t } = useTranslation('feed');
  const colors = useLiveSessionColors();
  const names = liveNamesCopy(describeLiveNames(card, viewerUserId), t);
  const quiet = isQuietSession(card);
  const elapsed = elapsedParts(card.startedAtMs, nowMs);
  const grade = card.hardestSendGrade ? (formatGrade(card.hardestSendGrade) ?? card.hardestSendGrade) : null;
  const sends = card.sendCount > 0 ? t('mobile.liveSessions.sends', { count: card.sendCount }) : null;
  const meta = [elapsedShort(elapsed, t), sends].filter((part): part is string => part != null).join(' · ');
  const spoken = [
    names.spoken,
    quiet ? t('mobile.liveSessions.a11y.quietNow') : t('mobile.liveSessions.a11y.liveNow'),
    startedSpoken(elapsed, t),
    sends,
    grade ? t('mobile.liveSessions.a11y.hardest', { grade }) : null,
  ]
    .filter((part): part is string => part != null)
    .join(', ');
  const handlePress = useCallback(() => onPress(card), [onPress, card]);

  return (
    <PressableSurface
      testID="board-live-session-row"
      onPress={handlePress}
      feedback="opacity"
      accessibilityRole="button"
      accessibilityLabel={spoken}
      accessibilityHint={t('mobile.liveSessions.a11y.hint')}
      style={[styles.row, { backgroundColor: colors.surface }]}
    >
      <AvatarGroup
        participants={card.participants.length > 0 ? card.participants : card.host ? [card.host] : []}
        total={Math.max(card.participantCount, card.participants.length)}
        size={ROW_AVATAR_SIZE}
        max={3}
        interactive={false}
        ringColor={colors.surface}
        highlightUserId={card.host?.userId ?? null}
        highlightColor={colors.live}
      />
      <View style={styles.rowText}>
        <View style={styles.namesRow}>
          <Text variant="subheadline" color={colors.label} numberOfLines={1} style={[styles.bold, styles.shrink]}>
            {names.names}
          </Text>
          {names.extra ? (
            <Text variant="subheadline" color={colors.label} style={[styles.bold, styles.noShrink]}>
              {` ${names.extra}`}
            </Text>
          ) : null}
        </View>
        <View style={styles.metaRow}>
          <LiveStatusDot color={quiet ? colors.meta : colors.live} quiet={quiet} />
          <Text variant="footnote" color={colors.meta} numberOfLines={1} style={styles.shrink}>
            {meta}
          </Text>
          {grade && card.hardestSendGrade ? <LiveGradeChip rawGrade={card.hardestSendGrade} label={grade} /> : null}
        </View>
      </View>
      {/* The climber is standing at this wall, so Join is the filled primary. */}
      <LiveActionPill
        label={card.viewerIsMember ? t('mobile.liveSessions.actions.open') : t('mobile.liveSessions.actions.join')}
        colors={colors}
        tone="filled"
      />
    </PressableSurface>
  );
});

function BoardLiveSessionsBlockComponent({
  boardId,
  holderName,
  holderUserId,
  onBeforeNavigate,
}: BoardLiveSessionsBlockProps) {
  const { t } = useTranslation('feed');
  const colors = useLiveSessionColors();
  const backgrounded = useIsAppBackgrounded();
  const { formatGrade } = useGradeFormat();
  const { data: profile } = useProfile();
  const viewerUserId = profile?.id ?? null;
  const { sessionId: queueSessionId } = useQueueSessionId();
  const queueSessionIdRef = useRef(queueSessionId);
  queueSessionIdRef.current = queueSessionId;

  const query = useBoardLiveSessions(boardId, boardId != null);
  const offline = useOfflineQueryState(query);
  const cards = query.data ?? EMPTY_CARDS;
  const hasRows = cards.length > 0;
  const viewerInSession = queueSessionId != null || cards.some((card) => card.viewerIsMember);

  const nowMs = useElapsedClock(hasRows && !backgrounded, startedAtKeyFor(cards));
  // Only sessions with somebody connected pulse; a quiet row's dot is static.
  useLivePulseDriver(countLiveNow(cards) > 0 && !backgrounded);

  // Once per sheet open (the panel unmounts on dismiss), with settled data.
  const viewedRef = useRef(false);
  const settledState =
    query.data !== undefined
      ? hasRows
        ? 'loaded'
        : 'empty'
      : offline.isBlocked
        ? offline.reason === 'offline' || offline.reason === 'offline_mode'
          ? 'offline'
          : 'error'
        : null;
  const cardCount = cards.length;
  useEffect(() => {
    if (settledState == null || viewedRef.current) return;
    viewedRef.current = true;
    track(SHARED_EVENTS.LiveSessionsShelfViewed, { surface: 'board_sheet', count: cardCount, state: settledState });
  }, [settledState, cardCount]);

  // One handoff at a time: a second tap while the sheet is settling must not
  // queue a second push. Claimed before the first await.
  const leavingRef = useRef(false);
  const leaveSheetThen = useCallback(
    async (navigate: () => void) => {
      if (leavingRef.current) return;
      leavingRef.current = true;
      try {
        const proceed = onBeforeNavigate ? await onBeforeNavigate() : true;
        if (proceed) navigate();
      } finally {
        leavingRef.current = false;
      }
    },
    [onBeforeNavigate],
  );

  const handleRowPress = useCallback(
    (card: LiveCardModel) => {
      hapticLight();
      track(SHARED_EVENTS.LiveSessionCardTapped, {
        surface: 'board_sheet',
        reason: card.reasons[0] ?? null,
        viewerIsMember: card.viewerIsMember,
        participantCount: card.participantCount,
      });
      const openRecord = card.viewerIsMember && card.sessionId === queueSessionIdRef.current;
      void leaveSheetThen(() => {
        if (openRecord) {
          router.navigate('/(tabs)/record');
          return;
        }
        router.push({ pathname: '/join/[sessionId]', params: { sessionId: card.sessionId, source: 'board_sheet' } });
      });
    },
    [leaveSheetThen],
  );

  const handleStartPress = useCallback(() => {
    hapticLight();
    track(SHARED_EVENTS.StartSessionPromptTapped, { surface: 'board_sheet', variant: 'board_sheet' });
    void leaveSheetThen(() => router.navigate('/(tabs)/record'));
  }, [leaveSheetThen]);

  // Nothing before the first answer, and nothing on error or offline with no
  // answer yet: a sheet must not jump. Once rows have loaded, a failed poll
  // keeps them on screen rather than blinking the block away.
  if (query.data === undefined) return null;
  if (!hasRows && viewerInSession) return null;

  const header = (
    <Text variant="footnote" color={colors.meta} style={styles.sectionHeader}>
      {t('mobile.liveSessions.board.header')}
    </Text>
  );

  if (!hasRows) {
    const namedClimber = holderName && holderUserId !== viewerUserId ? holderName : null;
    const body = namedClimber
      ? t('mobile.liveSessions.board.emptyBodyLitBy', { name: namedClimber })
      : t('mobile.liveSessions.board.emptyBody');
    return (
      <View testID="board-live-sessions-empty">
        {header}
        <View style={[styles.emptyBlock, { backgroundColor: colors.surface }]}>
          <View style={styles.emptyTop}>
            <View style={styles.seats} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <Avatar uri={profile?.avatarUrl} name={profile?.displayName} size={ROW_AVATAR_SIZE} />
              <View style={[styles.openSeat, { borderColor: colors.meta }]}>
                <Icon name="plus" size={12} color={colors.meta} />
              </View>
            </View>
            <View style={styles.rowText}>
              <Text variant="subheadline" color={colors.label} style={styles.bold}>
                {t('mobile.liveSessions.board.emptyTitle')}
              </Text>
              <Text variant="footnote" color={colors.meta}>
                {body}
              </Text>
            </View>
          </View>
          <PressableSurface
            testID="board-live-sessions-start"
            onPress={handleStartPress}
            feedback="scale"
            accessibilityRole="button"
            accessibilityLabel={t('mobile.liveSessions.board.emptyCta')}
            style={[styles.startButton, { backgroundColor: colors.tintFill, borderColor: colors.tintBorder }]}
          >
            <Icon name="record" size={18} color={colors.primary} />
            <Text variant="subheadline" color={colors.primary} style={styles.bold}>
              {t('mobile.liveSessions.board.emptyCta')}
            </Text>
          </PressableSurface>
        </View>
      </View>
    );
  }

  const shown = cards.slice(0, BOARD_LIVE_SESSIONS_MAX_ROWS);
  const hidden = cards.length - shown.length;

  return (
    <View testID="board-live-sessions">
      {header}
      <View style={styles.rows}>
        {shown.map((card) => (
          <BoardLiveSessionRow
            key={card.sessionId}
            card={card}
            nowMs={nowMs}
            viewerUserId={viewerUserId}
            formatGrade={formatGrade}
            onPress={handleRowPress}
          />
        ))}
        {hidden > 0 ? (
          <Text variant="footnote" color={colors.meta} style={styles.more}>
            {t('mobile.liveSessions.board.more', { count: hidden })}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export const BoardLiveSessionsBlock = memo(BoardLiveSessionsBlockComponent);

const styles = StyleSheet.create({
  // Matches the panel's own "This wall" section header.
  sectionHeader: {
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    paddingBottom: spacing[2],
  },
  rows: {
    paddingHorizontal: spacing[4],
    gap: spacing[2],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    padding: spacing[3],
    borderRadius: borderRadius.lg,
  },
  rowText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  namesRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  shrink: { flexShrink: 1 },
  noShrink: { flexShrink: 0 },
  bold: { fontWeight: '600' },
  more: {
    paddingHorizontal: spacing[1],
  },
  emptyBlock: {
    marginHorizontal: spacing[4],
    padding: spacing[3],
    borderRadius: borderRadius.lg,
    gap: spacing[3],
  },
  emptyTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing[3],
  },
  seats: {
    flexDirection: 'row',
    gap: spacing[1],
  },
  openSeat: {
    width: ROW_AVATAR_SIZE,
    height: ROW_AVATAR_SIZE,
    borderRadius: ROW_AVATAR_SIZE / 2,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  startButton: {
    minHeight: ACTION_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[2],
    borderRadius: borderRadius.full,
    borderWidth: 1,
  },
});
