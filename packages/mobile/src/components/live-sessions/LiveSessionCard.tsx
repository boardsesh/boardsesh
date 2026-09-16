import { memo, useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import { readableTextColor } from '@boardsesh/board-constants/readable-text-color';
import { Text } from '../Text';
import { Button } from '../Button';
import { PressableSurface } from '../PressableSurface';
import { AvatarGroup } from '../you/AvatarGroup';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { borderRadius, spacing } from '../../theme/tokens';
import { LiveDot } from './LiveDot';
import {
  describeLiveNames,
  elapsedParts,
  isListedForFollowedBoardOnly,
  liveCardAction,
  LIVE_TILE_WIDTH,
  type LiveCardModel,
} from './live-session-model';
import { elapsedShort, liveBoardLine, liveCardSpokenLabel, liveNamesCopy } from './live-session-copy';
import { useLiveSessionColors, type LiveSessionColors } from './use-live-session-colors';

const AVATAR_SIZE = 40;
const ACTION_HEIGHT = 44;
const TILE_PADDING = 12;

export type LiveSessionCardProps = {
  card: LiveCardModel;
  /** Epoch minute from the rail's single minute tick. */
  nowMinute: number;
  viewerUserId: string | null;
  height: number;
  /** Above 1.2× text the action drops under the stats. */
  stacked: boolean;
  formatGrade: (grade: string | null | undefined) => string | null;
  onPress: (card: LiveCardModel) => void;
  onInvite: (sessionId: string) => void;
};

/** A filled grade chip. Black or white ink, whichever reads on the grade colour. */
export const LiveGradeChip = memo(function LiveGradeChip({ rawGrade, label }: { rawGrade: string; label: string }) {
  const fill = getGradeColor(rawGrade) ?? DEFAULT_GRADE_COLOR;
  return (
    <View style={[styles.gradeChip, { backgroundColor: fill }]}>
      <Text
        variant="caption1"
        color={readableTextColor(fill)}
        maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
        style={styles.bold}
      >
        {label}
      </Text>
    </View>
  );
});

export const LivePill = memo(function LivePill({ colors }: { colors: LiveSessionColors }) {
  const { t } = useTranslation('feed');
  return (
    <View style={[styles.livePill, { backgroundColor: colors.live }]}>
      <LiveDot color={colors.liveInk} size={6} />
      <Text
        variant="caption1"
        color={colors.liveInk}
        maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
        style={styles.bold}
      >
        {t('mobile.liveSessions.live')}
      </Text>
    </View>
  );
});

function LiveSessionCardComponent({
  card,
  nowMinute,
  viewerUserId,
  height,
  stacked,
  formatGrade,
  onPress,
  onInvite,
}: LiveSessionCardProps) {
  const { t } = useTranslation('feed');
  const colors = useLiveSessionColors();

  const names = liveNamesCopy(describeLiveNames(card, viewerUserId), t);
  const elapsed = elapsedParts(card.startedAtMs, nowMinute * 60_000);
  const boardLine = liveBoardLine(card, t);
  const followOnly = isListedForFollowedBoardOnly(card);
  const hardestGrade = card.hardestSendGrade ? (formatGrade(card.hardestSendGrade) ?? card.hardestSendGrade) : null;
  const climbGrade = card.currentClimbGrade ? (formatGrade(card.currentClimbGrade) ?? card.currentClimbGrade) : null;
  const action = liveCardAction(card);
  const spokenLabel = liveCardSpokenLabel({ names, card, elapsed, hardestGrade, climbGrade }, t);

  const handlePress = useCallback(() => onPress(card), [onPress, card]);
  const handleInvite = useCallback(() => onInvite(card.sessionId), [onInvite, card.sessionId]);

  const stats = (
    <View style={[styles.stats, stacked && styles.statsStacked]}>
      <Text variant="footnote" color={colors.meta} numberOfLines={1} style={styles.shrink}>
        <Text variant="footnote" color={colors.label} style={styles.bold}>
          {elapsedShort(elapsed, t)}
        </Text>
        {card.sendCount > 0 ? ` · ${t('mobile.liveSessions.sends', { count: card.sendCount })}` : ''}
      </Text>
      {hardestGrade && card.hardestSendGrade ? (
        <LiveGradeChip rawGrade={card.hardestSendGrade} label={hardestGrade} />
      ) : null}
    </View>
  );

  const actionLabel = action === 'join' ? t('mobile.liveSessions.actions.join') : t('mobile.liveSessions.actions.open');

  return (
    <View style={[styles.tile, { height }]} testID="live-session-card">
      <PressableSurface
        onPress={handlePress}
        feedback="scale"
        scaleTo={0.98}
        accessibilityRole="button"
        accessibilityLabel={spokenLabel}
        accessibilityHint={t('mobile.liveSessions.a11y.hint')}
        style={[styles.surface, { backgroundColor: colors.surface, borderColor: colors.border }]}
      >
        <View style={styles.headRow}>
          <AvatarGroup
            participants={card.participants.length > 0 ? card.participants : card.host ? [card.host] : []}
            total={Math.max(card.participantCount, card.participants.length)}
            size={AVATAR_SIZE}
            max={3}
            interactive={false}
            ringColor={colors.surface}
            highlightUserId={card.host?.userId ?? null}
            highlightColor={colors.live}
          />
          <LivePill colors={colors} />
        </View>

        <View style={styles.namesRow}>
          <Text variant="headline" color={colors.label} numberOfLines={1} style={styles.shrink}>
            {names.names}
          </Text>
          {names.extra ? (
            <Text variant="headline" color={colors.label} style={styles.noShrink}>
              {` ${names.extra}`}
            </Text>
          ) : null}
        </View>
        {boardLine ? (
          <Text variant="subheadline" color={colors.meta} numberOfLines={1}>
            {boardLine}
          </Text>
        ) : null}
        {followOnly || card.gymName ? (
          <Text variant="footnote" color={colors.meta} numberOfLines={1}>
            {followOnly ? (
              <Text variant="footnote" color={colors.primary} style={styles.bold}>
                {t('mobile.liveSessions.boardYouFollow')}
              </Text>
            ) : null}
            {followOnly && card.gymName ? ' · ' : ''}
            {card.gymName ?? ''}
          </Text>
        ) : null}
        {card.currentClimbName ? (
          <Text variant="footnote" color={colors.meta} numberOfLines={1}>
            {climbGrade
              ? t('mobile.liveSessions.onClimbGrade', { climb: card.currentClimbName, grade: climbGrade })
              : t('mobile.liveSessions.onClimb', { climb: card.currentClimbName })}
          </Text>
        ) : null}

        <View style={styles.spacer} />

        {stacked ? stats : null}
        <View style={styles.footer}>
          {stacked ? <View style={styles.shrink} /> : stats}
          {action === 'invite' ? (
            // Holds the footer's height; the real Invite button floats above the
            // pressable so it is its own tap target and its own a11y element.
            <View style={styles.invitePlaceholder} />
          ) : (
            <View
              style={[
                styles.actionPill,
                stacked && styles.actionPillStacked,
                { backgroundColor: colors.tintFill, borderColor: colors.tintBorder },
              ]}
            >
              <Text variant="subheadline" color={colors.primary} numberOfLines={1} style={styles.bold}>
                {actionLabel}
              </Text>
            </View>
          )}
        </View>
      </PressableSurface>
      {action === 'invite' ? (
        <View style={[styles.inviteSlot, stacked && styles.inviteSlotStacked]}>
          <Button
            title={t('mobile.liveSessions.actions.invite')}
            accessibilityLabel={t('mobile.liveSessions.a11y.invite')}
            variant="tonal"
            size="small"
            minHeight={ACTION_HEIGHT}
            onPress={handleInvite}
          />
        </View>
      ) : null}
    </View>
  );
}

export const LiveSessionCard = memo(LiveSessionCardComponent);

const styles = StyleSheet.create({
  tile: {
    width: LIVE_TILE_WIDTH,
  },
  surface: {
    flex: 1,
    padding: TILE_PADDING,
    borderRadius: borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  headRow: {
    height: AVATAR_SIZE + 4,
    marginTop: -2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  livePill: {
    minHeight: 22,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingLeft: 7,
    paddingRight: spacing[2],
    paddingVertical: 2,
    borderRadius: borderRadius.full,
  },
  namesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  shrink: { flexShrink: 1 },
  noShrink: { flexShrink: 0 },
  bold: { fontWeight: '700' },
  spacer: { flex: 1 },
  stats: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minWidth: 0,
  },
  statsStacked: {
    flex: 0,
    marginBottom: spacing[2],
  },
  footer: {
    minHeight: ACTION_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  gradeChip: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 6,
    flexShrink: 0,
  },
  actionPill: {
    height: ACTION_HEIGHT,
    paddingHorizontal: spacing[4],
    borderRadius: borderRadius.full,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  actionPillStacked: {
    flexGrow: 1,
  },
  invitePlaceholder: {
    width: 96,
    height: ACTION_HEIGHT,
  },
  inviteSlot: {
    position: 'absolute',
    right: TILE_PADDING,
    bottom: TILE_PADDING,
  },
  inviteSlotStacked: {
    left: TILE_PADDING,
  },
});
