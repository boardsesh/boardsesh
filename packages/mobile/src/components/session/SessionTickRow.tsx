import { memo, useCallback } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { SessionDetailTick, SessionFeedParticipant } from '@boardsesh/shared-schema';
import { getGradeTextColor } from '@boardsesh/play-view';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { type IconName } from '../icon-map';
import { ListRow } from '../ListRow';
import { PressableAvatar } from '../PressableAvatar';
import { PressableSurface } from '../PressableSurface';
import { ClimbListItemContent } from '../ClimbListItemContent';
import { gradeBadgeColor } from '../you/profile-chart-colors';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { useTheme } from '../../providers/theme-provider';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { brandColors, withAlpha } from '../../theme/colors';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, borderRadius } from '../../theme/tokens';
import { getBoardConfigForPlaylist } from '../../lib/playlists/board-details-for-playlist';
import { sessionTickToClimb } from '../../lib/session-tick-mapping';
import { tickToClimb } from '../../lib/tick-to-climb';
import { hapticSelection, hapticMedium } from '../../lib/haptics';

type TickStatusMeta = { icon: IconName; color: string };

// The status badge is a FILL with a white icon on top, so the brand tones stay
// STATIC (the lifted dark tints would fail white-on-fill contrast). Module-level
// constants → zero allocation per row in this virtualised list.
const STATUS_META: Record<string, TickStatusMeta> = {
  flash: { icon: 'flash', color: brandColors.warning },
  send: { icon: 'tick', color: brandColors.success },
};
const ATTEMPT_META: TickStatusMeta = { icon: 'circle', color: iosSystemColors.systemGray };

// Leading status disc / avatar size. Shared by the styles and the separator
// inset so the hairline always aligns past the disc + its two gutters.
const STATUS_ICON_SIZE = 28;

function statusMeta(status: string): TickStatusMeta {
  return STATUS_META[status] ?? ATTEMPT_META;
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

/** Attempt subtitle, mirroring web's `formatAttemptText`. */
function formatAttemptText(tick: SessionDetailTick, t: TFunc): string | null {
  if (tick.status === 'flash') return null;
  const sessionAttempts = tick.attemptCount;
  const total = tick.totalAttempts;

  if (tick.status === 'send') {
    const parts = [t('detail.attemptOnNth', { ordinal: ordinalSuffix(sessionAttempts, t) })];
    if (total != null && total > sessionAttempts) parts.push(t('detail.totalAttempts', { count: total }));
    return parts.join(', ');
  }

  const parts = [t('detail.attemptCount', { count: sessionAttempts })];
  if (total != null && total > sessionAttempts) parts.push(t('detail.totalAttempts', { count: total }));
  return parts.join(', ');
}

type SessionTickRowProps = {
  tick: SessionDetailTick;
  isMultiUser: boolean;
  /** Participant who logged the tick, for the leading avatar in multi-user sessions. */
  participant?: SessionFeedParticipant;
  onPress: (tick: SessionDetailTick) => void;
};

export const SessionTickRow = memo(function SessionTickRow({
  tick,
  isMultiUser,
  participant,
  onPress,
}: SessionTickRowProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const { formatGrade, formatGradeByDifficultyId } = useGradeFormat();
  const { openClimbActions } = useDrawerHost();

  const meta = statusMeta(tick.status);
  const attemptText = formatAttemptText(tick, t);
  // The setter moves out of the climb's primary subtitle into the detail line,
  // explicitly labelled, so it's never misread as the person who sent the climb.
  const setterText = tick.setterUsername ? t('detail.setBy', { username: tick.setterUsername }) : null;
  const detailParts = [attemptText, tick.comment ?? null, setterText].filter((part): part is string => !!part);
  // fallbackSubtitle is used only by the ListRow path (climb/boardConfig missing).
  // In the ClimbListItemContent path, participant name is surfaced via
  // primarySubtitleOverride and attempt/comment/setter via subtitleDetailParts.
  // ListRow has no detail line, so setterText is excluded here to avoid it
  // appearing in the only subtitle slot alongside the attempt/comment text.
  const fallbackSubtitle =
    [attemptText, tick.comment ?? null].filter((part): part is string => !!part).join(' · ') || undefined;

  const handlePress = useCallback(() => {
    hapticSelection();
    onPress(tick);
  }, [onPress, tick]);

  // Long press → reaction menu. tickToClimb gives the full schema Climb the menu
  // needs (sessionTickToClimb returns only the permissive list-visual shape); the
  // board config + angle match the play-drawer open. No-ops without frames.
  const handleLongPress = useCallback(() => {
    const menuClimb = tickToClimb(tick);
    const config = getBoardConfigForPlaylist(tick.boardType, tick.layoutId);
    if (!menuClimb || !config) return;
    hapticMedium();
    openClimbActions(menuClimb, {
      boardName: config.boardName,
      layoutId: config.layoutId,
      sizeId: config.sizeId,
      setIds: config.setIds.join(','),
      angle: tick.angle,
    });
  }, [tick, openClimbActions]);

  const climb = sessionTickToClimb(tick);
  // getBoardConfigForPlaylist memoises internally (static board metadata), so
  // this per-row call is O(1) after the first lookup for the board.
  const boardConfig = getBoardConfigForPlaylist(tick.boardType, tick.layoutId);

  if (climb && boardConfig) {
    return (
      <View>
        <PressableSurface
          onPress={handlePress}
          onLongPress={handleLongPress}
          feedback="opacity"
          opacityTo={0.7}
          accessibilityRole="button"
          accessibilityLabel={tick.climbName ?? t('detail.unknownClimb')}
          style={[styles.row, { backgroundColor: systemColors.secondaryBackground }]}
        >
          {isMultiUser ? (
            <PressableAvatar
              userId={participant?.userId}
              uri={participant?.avatarUrl}
              name={participant?.displayName}
              size={28}
            />
          ) : (
            <View style={styles.statusSlot}>
              <View style={[styles.statusIcon, { backgroundColor: withAlpha(meta.color, 0.15) }]}>
                <Icon name={meta.icon} size={14} color={meta.color} />
              </View>
            </View>
          )}
          <ClimbListItemContent
            climb={climb}
            boardName={boardConfig.boardName}
            layoutId={boardConfig.layoutId}
            sizeId={boardConfig.sizeId}
            setIds={boardConfig.setIds.join(',')}
            angle={tick.angle}
            subtitleDetailParts={detailParts}
            showAscentStatus={false}
            primarySubtitleOverride={isMultiUser ? (participant?.displayName ?? null) : null}
          />
        </PressableSurface>
        <View style={[styles.separator, { backgroundColor: systemColors.separator }]} />
      </View>
    );
  }

  const gradeLabel =
    formatGradeByDifficultyId(tick.difficulty) ?? formatGrade(tick.difficultyName) ?? tick.difficultyName;
  const gradeColor = gradeLabel ? gradeBadgeColor(tick.difficultyName ?? gradeLabel) : undefined;

  return (
    <ListRow
      title={tick.climbName ?? t('detail.unknownClimb')}
      subtitle={fallbackSubtitle}
      onPress={handlePress}
      leading={
        isMultiUser ? (
          <PressableAvatar
            userId={participant?.userId}
            uri={participant?.avatarUrl}
            name={participant?.displayName}
            size={28}
          />
        ) : (
          <View style={[styles.badge, { backgroundColor: meta.color }]}>
            <Icon name={meta.icon} size={14} color={iosSystemColors.white} />
          </View>
        )
      }
      trailing={
        gradeLabel && gradeColor ? (
          <View style={[styles.gradePill, { backgroundColor: gradeColor }]}>
            <Text variant="caption1" color={getGradeTextColor(gradeColor)} style={styles.gradeText}>
              {gradeLabel}
            </Text>
          </View>
        ) : undefined
      }
    />
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: spacing[3],
    paddingVertical: spacing[2],
    paddingHorizontal: spacing[3],
  },
  statusSlot: {
    width: STATUS_ICON_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusIcon: {
    width: STATUS_ICON_SIZE,
    height: STATUS_ICON_SIZE,
    borderRadius: STATUS_ICON_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: spacing[3] + STATUS_ICON_SIZE + spacing[3],
  },
  badge: {
    width: STATUS_ICON_SIZE,
    height: STATUS_ICON_SIZE,
    borderRadius: STATUS_ICON_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gradePill: {
    paddingHorizontal: spacing[2],
    paddingVertical: 2,
    borderRadius: borderRadius.sm,
  },
  gradeText: { fontWeight: '700' },
});
