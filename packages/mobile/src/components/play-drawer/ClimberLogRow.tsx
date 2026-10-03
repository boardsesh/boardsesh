// One climber's row in the "Climber logs" card and its full list: who, when,
// how it went, at what angle, the grade and stars they gave, and their note.
// The row is the whole tap target and opens the climber's profile. No follow
// button, no votes: the list answers "how did it go for them", nothing else.
import { memo, useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Avatar } from '../Avatar';
import { Text } from '../Text';
import { PressableSurface } from '../PressableSurface';
import { AscentStatusMark, GradePill, StarNumber } from '../ascent-marks';
import { describeResult, type ClimberLog, type ClimberLogGroup, type ClimberLogResult } from './climber-logs';
import type { AscentStatusValue } from '../../lib/ascent-status-utils';
import { formatRelativeTime } from '../../lib/format-relative-time';
import { useTheme } from '../../providers/theme-provider';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, borderRadius } from '../../theme/tokens';

type ClimberLogRowProps = {
  group: ClimberLogGroup;
  /** The angle the board is set to; a log at it gets the filled angle pill. */
  boardAngle: number;
  noteLines?: number;
  /** Hide the "+N earlier logs" line. Set when the rows are cut by the server's
   *  cap, where the count behind that line would be wrong. */
  hideEarlier?: boolean;
  onPressClimber: (userId: string) => void;
  /** Makes the earlier-logs line a button. Absent, it is plain text. */
  onPressEarlier?: (userId: string) => void;
  earlierExpanded?: boolean;
};

const AVATAR_SIZE = 36;
const MIN_TARGET = 44;

const MARK_STATUS: Record<ClimberLogResult['kind'], AscentStatusValue> = {
  flash: 'flash',
  sent: 'send',
  noSend: 'attempt',
};

function resultWords(result: ClimberLogResult, t: TFunction<'session'>): string {
  switch (result.kind) {
    case 'flash':
      return t('mobile.climberLogs.resultFlash');
    case 'sent':
      return t('mobile.climberLogs.resultSentIn', { count: result.tries });
    default:
      return t('mobile.climberLogs.resultNoSend', { count: result.tries });
  }
}

/** Status mark and result words, the angle, then the grade and stars a send carries. */
const LogMeta = memo(function LogMeta({ log, boardAngle }: { log: ClimberLog; boardAngle: number }) {
  const { t } = useTranslation('session');
  const { brandColors, systemColors } = useTheme();
  const result = describeResult(log);
  const atBoardAngle = log.angle === boardAngle;

  return (
    <View style={styles.meta}>
      <View style={styles.result}>
        <AscentStatusMark status={MARK_STATUS[result.kind]} />
        <Text variant="footnote" style={styles.resultWords}>
          {resultWords(result, t)}
        </Text>
      </View>
      <View
        testID={atBoardAngle ? 'climber-log-angle-here' : 'climber-log-angle-other'}
        style={[styles.anglePill, { backgroundColor: atBoardAngle ? brandColors.primaryFill : systemColors.fill }]}
      >
        <Text
          variant="caption2"
          color={atBoardAngle ? iosSystemColors.white : systemColors.secondaryLabel}
          style={styles.angleLabel}
        >
          {`${log.angle}°`}
        </Text>
      </View>
      <GradePill difficultyId={log.difficulty} />
      {/* An attempt carries no rating: the server already nulls the fallback for it. */}
      {result.kind === 'noSend' ? null : <StarNumber quality={log.effectiveQuality ?? log.quality} />}
    </View>
  );
});

export const ClimberLogRow = memo(function ClimberLogRow({
  group,
  boardAngle,
  noteLines = 3,
  hideEarlier = false,
  onPressClimber,
  onPressEarlier,
  earlierExpanded = false,
}: ClimberLogRowProps) {
  const { t } = useTranslation('session');
  const { brandColors, systemColors } = useTheme();
  const { lead, earlier, userId } = group;
  const name = group.displayName ?? t('mobile.climberLogs.unknownClimber');
  const note = lead.comment.trim();

  const handlePress = useCallback(() => onPressClimber(userId), [onPressClimber, userId]);
  const handlePressEarlier = useCallback(() => onPressEarlier?.(userId), [onPressEarlier, userId]);

  const earlierLine =
    hideEarlier || earlier.length === 0
      ? null
      : t('mobile.climberLogs.earlierDetail', {
          logs: t('mobile.climberLogs.earlierLogs', { count: earlier.length }),
          tries: t('mobile.logbook.tries', { count: group.earlierTries }),
          days: t('mobile.climberLogs.earlierDays', { count: group.earlierDays }),
        });

  return (
    <View style={styles.row}>
      <PressableSurface
        onPress={handlePress}
        feedback="opacity"
        accessibilityRole="button"
        accessibilityLabel={t('mobile.climberLogs.rowA11y', {
          name,
          result: resultWords(describeResult(lead), t),
          angle: lead.angle,
        })}
        style={styles.pressable}
      >
        <Avatar uri={group.avatarUrl} name={name} size={AVATAR_SIZE} />
        <View style={styles.body}>
          <View style={styles.top}>
            <Text variant="subheadline" numberOfLines={1} style={styles.name}>
              {name}
            </Text>
            <Text variant="caption1" color={systemColors.secondaryLabel}>
              {formatRelativeTime(lead.climbedAt)}
            </Text>
          </View>
          <LogMeta log={lead} boardAngle={boardAngle} />
          {note ? (
            <Text variant="subheadline" numberOfLines={noteLines}>
              {note}
            </Text>
          ) : null}
          {earlierLine && !onPressEarlier ? (
            <Text variant="caption1" color={systemColors.secondaryLabel}>
              {earlierLine}
            </Text>
          ) : null}
        </View>
      </PressableSurface>
      {/* A sibling of the row button, not a child: a button inside a button is
          unreachable for VoiceOver and TalkBack. */}
      {earlierLine && onPressEarlier ? (
        <PressableSurface
          onPress={handlePressEarlier}
          feedback="opacity"
          accessibilityRole="button"
          accessibilityState={{ expanded: earlierExpanded }}
          style={styles.earlierButton}
        >
          <Text variant="caption1" color={brandColors.primary}>
            {earlierLine}
          </Text>
        </PressableSurface>
      ) : null}
    </View>
  );
});

/** One of a climber's other logs, shown in place under their row in the full list. */
export const ClimberLogEarlierRow = memo(function ClimberLogEarlierRow({
  log,
  boardAngle,
}: {
  log: ClimberLog;
  boardAngle: number;
}) {
  const { systemColors } = useTheme();
  const note = log.comment.trim();

  return (
    <View style={[styles.earlierRow, { borderLeftColor: systemColors.separator }]}>
      <View style={styles.top}>
        <View style={styles.earlierMeta}>
          <LogMeta log={log} boardAngle={boardAngle} />
        </View>
        <Text variant="caption1" color={systemColors.secondaryLabel}>
          {formatRelativeTime(log.climbedAt)}
        </Text>
      </View>
      {note ? (
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {note}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    minHeight: 56,
  },
  pressable: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing[3],
    paddingVertical: spacing[2],
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: spacing[1],
  },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  name: {
    flex: 1,
    fontWeight: '600',
  },
  meta: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing[2],
  },
  result: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
  },
  resultWords: {
    fontWeight: '600',
  },
  anglePill: {
    paddingHorizontal: spacing[2],
    paddingVertical: 1,
    borderRadius: borderRadius.full,
  },
  angleLabel: {
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  earlierButton: {
    minHeight: MIN_TARGET,
    justifyContent: 'center',
    // Lines the label up with the text column beside the avatar.
    marginLeft: AVATAR_SIZE + spacing[3],
  },
  earlierRow: {
    marginLeft: AVATAR_SIZE / 2,
    paddingLeft: AVATAR_SIZE / 2 + spacing[3],
    paddingVertical: spacing[2],
    borderLeftWidth: StyleSheet.hairlineWidth,
    gap: spacing[1],
  },
  earlierMeta: {
    flex: 1,
    minWidth: 0,
  },
});
