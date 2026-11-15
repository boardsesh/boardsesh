import { getGradeTextColor } from '@boardsesh/play-view';
import type { SessionDetailTick, SessionFeedParticipant } from '@boardsesh/shared-schema';
import { memo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { isMultiFrameClimb } from '../../lib/is-multi-frame-climb';
import { sessionTickToClimb } from '../../lib/session-tick-mapping';
import { useTheme } from '../../providers/theme-provider';
import { brandColors, withAlpha } from '../../theme/colors';
import { iosSystemColors } from '../../theme/ios-colors';
import { borderRadius, spacing } from '../../theme/tokens';
import { Icon } from '../Icon';
import { type IconName } from '../icon-map';
import { ListRow } from '../ListRow';
import { Text } from '../Text';

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
export function formatAttemptText(tick: SessionDetailTick, t: TFunc): string | null {
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

export type SessionTickRowViewProps = {
  climbContent?: ReactNode;
  avatar?: ReactNode;
  wrapClimbRow: (
    children: ReactNode,
    accessibilityLabel: string,
    style: import('react-native').StyleProp<import('react-native').ViewStyle>,
  ) => ReactNode;
  gradeLabel: string | null | undefined;
  gradeColor?: string;
  tick: SessionDetailTick;
  isMultiUser: boolean;
  /** Participant who logged the tick, for the leading avatar in multi-user sessions. */
  participant?: SessionFeedParticipant;
  onPress: (tick: SessionDetailTick) => void;
};

export const SessionTickRowView = memo(function SessionTickRowView({
  climbContent,
  avatar,
  wrapClimbRow,
  gradeLabel,
  gradeColor,
  tick,
  isMultiUser,
  onPress,
}: SessionTickRowViewProps) {
  const { t } = useTranslation(['session', 'climbs']);
  const { systemColors, chartColors } = useTheme();
  const meta = statusMeta(tick.status);
  // The tinted disc (glyph on a 15% wash) adapts with the theme; only the solid
  // badge below keeps the static gray, since it carries a white glyph.
  const tintedStatusColor = STATUS_META[tick.status]?.color ?? chartColors.secondaryLabel;
  const attemptText = formatAttemptText(tick, t);
  const fallbackSubtitle =
    [attemptText, tick.comment ?? null].filter((part): part is string => !!part).join(' · ') || undefined;

  const handlePress = () => onPress(tick);

  const climb = sessionTickToClimb(tick);
  const climbLabel = tick.climbName ?? t('detail.unknownClimb');
  const rowAccessibilityLabel = isMultiFrameClimb(climb?.framesCount)
    ? `${climbLabel}, ${t('mobile.climbRow.frameCount', { ns: 'climbs', count: climb.framesCount })}`
    : climbLabel;
  if (climbContent) {
    return (
      <View>
        {wrapClimbRow(
          <>
            {isMultiUser ? (
              avatar
            ) : (
              <View style={styles.statusSlot}>
                <View style={[styles.statusIcon, { backgroundColor: withAlpha(tintedStatusColor, 0.15) }]}>
                  <Icon name={meta.icon} size={14} color={tintedStatusColor} />
                </View>
              </View>
            )}
            {climbContent}
          </>,
          rowAccessibilityLabel,
          [styles.row, { backgroundColor: systemColors.secondaryBackground }],
        )}

        <View style={[styles.separator, { backgroundColor: systemColors.separator }]} />
      </View>
    );
  }

  return (
    <ListRow
      title={tick.climbName ?? t('detail.unknownClimb')}
      subtitle={fallbackSubtitle}
      onPress={handlePress}
      leading={
        isMultiUser ? (
          avatar
        ) : (
          <View style={[styles.badge, { backgroundColor: meta.color }]}>
            <Icon name={meta.icon} size={14} color={iosSystemColors.white} />
          </View>
        )
      }
      trailing={
        gradeLabel && gradeColor ? (
          <View style={[styles.gradePill, { backgroundColor: gradeColor }]}>
            <Text variant="caption1" color={getGradeTextColor(gradeColor)} numeric style={styles.gradeText}>
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
    marginStart: spacing[3] + STATUS_ICON_SIZE + spacing[3],
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
