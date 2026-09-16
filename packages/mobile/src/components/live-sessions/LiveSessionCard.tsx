import { memo, useCallback, useMemo } from 'react';
import { StyleSheet, View, type AccessibilityActionEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { PressableSurface } from '../PressableSurface';
import { AvatarGroup } from '../you/AvatarGroup';
import { borderRadius, spacing } from '../../theme/tokens';
import {
  LIVE_ACTION_HEIGHT,
  LiveActionLabel,
  LiveActionPill,
  LiveGradeChip,
  LivePill,
  liveActionPillStyle,
} from './LiveBadges';
import {
  describeLiveNames,
  elapsedParts,
  isListedForFollowedBoardOnly,
  isQuietSession,
  liveCardAction,
  LIVE_TILE_WIDTH,
  type LiveCardModel,
} from './live-session-model';
import { elapsedShort, liveBoardLine, liveCardSpokenLabel, liveNamesCopy } from './live-session-copy';
import { useLiveSessionColors } from './use-live-session-colors';

const AVATAR_SIZE = 40;
const TILE_PADDING = 12;
const INVITE_ACTION = 'invite';

export type LiveSessionCardProps = {
  card: LiveCardModel;
  /** "Now" from the rail's single elapsed clock (epoch ms). */
  nowMs: number;
  viewerUserId: string | null;
  height: number;
  /** Above 1.2× text the action drops under the stats. */
  stacked: boolean;
  formatGrade: (grade: string | null | undefined) => string | null;
  onPress: (card: LiveCardModel) => void;
  onInvite: (sessionId: string) => void;
};

function LiveSessionCardComponent({
  card,
  nowMs,
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
  const elapsed = elapsedParts(card.startedAtMs, nowMs);
  const boardLine = liveBoardLine(card, t);
  const followOnly = isListedForFollowedBoardOnly(card);
  const hardestGrade = card.hardestSendGrade ? (formatGrade(card.hardestSendGrade) ?? card.hardestSendGrade) : null;
  const climbGrade = card.currentClimbGrade ? (formatGrade(card.currentClimbGrade) ?? card.currentClimbGrade) : null;
  const action = liveCardAction(card);
  const spokenLabel = liveCardSpokenLabel({ names, card, elapsed, hardestGrade, climbGrade }, t);

  const handlePress = useCallback(() => onPress(card), [onPress, card]);
  const handleInvite = useCallback(() => onInvite(card.sessionId), [onInvite, card.sessionId]);

  // VoiceOver and TalkBack reach Invite as a custom action on the card, the
  // pattern ClimbListRow uses: a pressable nested in the card's own accessible
  // element is otherwise invisible to them.
  const inviteLabel = t('mobile.liveSessions.a11y.invite');
  const accessibilityActions = useMemo(
    () => (action === 'invite' ? [{ name: INVITE_ACTION, label: inviteLabel }] : undefined),
    [action, inviteLabel],
  );
  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === INVITE_ACTION) handleInvite();
    },
    [handleInvite],
  );

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

  return (
    <PressableSurface
      testID="live-session-card"
      onPress={handlePress}
      feedback="scale"
      scaleTo={0.98}
      accessibilityRole="button"
      accessibilityLabel={spokenLabel}
      accessibilityHint={t('mobile.liveSessions.a11y.hint')}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={accessibilityActions ? handleAccessibilityAction : undefined}
      style={[styles.tile, { height, backgroundColor: colors.surface, borderColor: colors.border }]}
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
        <LivePill colors={colors} quiet={isQuietSession(card)} />
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
        {stacked ? null : stats}
        {action === 'invite' ? (
          // The one real button inside the card, laid out like Join so the two
          // read as the same control. Its tap never reaches the card's press.
          <PressableSurface
            testID="live-session-invite"
            onPress={handleInvite}
            feedback="scale"
            accessibilityRole="button"
            accessibilityLabel={inviteLabel}
            style={[
              liveActionPillStyle,
              stacked && styles.actionStacked,
              { backgroundColor: colors.tintFill, borderColor: colors.tintBorder },
            ]}
          >
            <LiveActionLabel color={colors.primary}>{t('mobile.liveSessions.actions.invite')}</LiveActionLabel>
          </PressableSurface>
        ) : (
          <LiveActionPill
            label={action === 'join' ? t('mobile.liveSessions.actions.join') : t('mobile.liveSessions.actions.open')}
            colors={colors}
            tone="tinted"
            style={stacked ? styles.actionStacked : undefined}
          />
        )}
      </View>
    </PressableSurface>
  );
}

export const LiveSessionCard = memo(LiveSessionCardComponent);

const styles = StyleSheet.create({
  tile: {
    width: LIVE_TILE_WIDTH,
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
    minHeight: LIVE_ACTION_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  actionStacked: {
    flexGrow: 1,
  },
});
