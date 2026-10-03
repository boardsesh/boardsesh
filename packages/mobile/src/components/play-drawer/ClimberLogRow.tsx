// The rows of the "Climber logs" card and its full list. Everything is said in
// words: no status disc, no angle or grade pill, no stars.
//
//   ClimberLogRow            a climber with something to say: a note, or a
//                            grade that disagrees with the climb's
//   ClimberLogBareRow        one or two climbers with nothing to add, as cells
//   ClimberLogEarlierRow     one of a climber's other logs, under their row
//   ClimberLogEarlierFoldRow that climber's plain repeat sends at one angle
//
// A name or face that opens a profile is its own tap target. The earlier-logs
// buttons sit beside those targets, never inside them.
import { memo, useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Avatar } from '../Avatar';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { PressableSurface } from '../PressableSurface';
import {
  describeResult,
  gradeDisagrees,
  type ClimberLog,
  type ClimberLogGroup,
  type ClimberLogResult,
} from './climber-logs';
import { formatRelativeTime } from '../../lib/format-relative-time';
import { getGradeLabel } from '../../lib/grade-label';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';

type ClimberLogRowProps = {
  group: ClimberLogGroup;
  /** The angle the board is set to. A log at it does not mention its angle. */
  boardAngle: number;
  /** The climb's grade at the board's angle, or null when it is not known. */
  climbGradeId: number | null;
  noteLines?: number;
  /** Hide the "+N earlier" words. Set when the rows are cut by the server's
   *  cap, where the count behind them would be wrong. */
  hideEarlier?: boolean;
  onPressClimber: (userId: string) => void;
  /** Makes the earlier-logs line a button. Absent, it is a few plain words. */
  onPressEarlier?: (userId: string) => void;
  earlierExpanded?: boolean;
};

const AVATAR_SIZE = 32;
const BARE_AVATAR_SIZE = 28;
const MIN_TARGET = 44;
const BARE_CELL_HEIGHT = 48;
/** Punctuation between the parts of a line, the same in every language. */
const SEPARATOR = ' · ';

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

/**
 * How a log went, in words: "Sent in 2", with "at 35°" only when the log is not
 * at the board's angle, and "graded it V4" only when that grade disagrees with
 * the climb's.
 */
function useLogWords(boardAngle: number, climbGradeId: number | null) {
  const { t } = useTranslation('session');
  const { formatGradeByDifficultyId } = useGradeFormat();
  return useCallback(
    (log: ClimberLog): { result: string; graded: string | null } => {
      const words = resultWords(describeResult(log), t);
      const result =
        log.angle === boardAngle ? words : t('mobile.climberLogs.resultAtAngle', { result: words, angle: log.angle });
      const grade = gradeDisagrees(log, boardAngle, climbGradeId)
        ? formatGradeByDifficultyId(log.difficulty) || getGradeLabel(log.difficulty)
        : '';
      return { result, graded: grade ? t('mobile.climberLogs.gradedIt', { grade }) : null };
    },
    [boardAngle, climbGradeId, formatGradeByDifficultyId, t],
  );
}

/** "+2 earlier logs · 9 tries over 2 days", as a button that opens them in place. */
const EarlierButton = memo(function EarlierButton({
  label,
  accessibilityLabel,
  expanded,
  onPress,
  inset,
}: {
  label: string;
  accessibilityLabel?: string;
  expanded: boolean;
  onPress: () => void;
  /** Lines the label up with the text column beside a row's avatar. */
  inset?: boolean;
}) {
  const { brandColors } = useTheme();
  return (
    <PressableSurface
      onPress={onPress}
      feedback="opacity"
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ expanded }}
      style={[styles.earlierButton, inset ? styles.earlierButtonInset : undefined]}
    >
      <Text variant="footnote" color={brandColors.primary} style={styles.strong}>
        {label}
      </Text>
      <Icon name={expanded ? 'chevron.up' : 'chevron.down'} size={14} color={brandColors.primary} />
    </PressableSurface>
  );
});

export const ClimberLogRow = memo(function ClimberLogRow({
  group,
  boardAngle,
  climbGradeId,
  noteLines = 3,
  hideEarlier = false,
  onPressClimber,
  onPressEarlier,
  earlierExpanded = false,
}: ClimberLogRowProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const logWords = useLogWords(boardAngle, climbGradeId);
  const { lead, earlier, userId } = group;
  const name = group.displayName ?? t('mobile.climberLogs.unknownClimber');
  const note = lead.comment.trim();
  const { result, graded } = logWords(lead);
  const when = formatRelativeTime(lead.climbedAt);

  const handlePress = useCallback(() => onPressClimber(userId), [onPressClimber, userId]);
  const handlePressEarlier = useCallback(() => onPressEarlier?.(userId), [onPressEarlier, userId]);

  const hasEarlier = !hideEarlier && earlier.length > 0;
  const earlierShort =
    hasEarlier && !onPressEarlier ? t('mobile.climberLogs.earlierShort', { count: earlier.length }) : null;

  return (
    <View style={styles.row}>
      <PressableSurface
        onPress={handlePress}
        feedback="opacity"
        accessibilityRole="button"
        accessibilityLabel={t('mobile.climberLogs.rowA11y', {
          name,
          result: [result, graded, when, note].filter(Boolean).join(', '),
        })}
        style={styles.pressable}
      >
        <Avatar uri={group.avatarUrl} name={name} size={AVATAR_SIZE} />
        <View style={styles.body}>
          {/* One wrapping line, no columns: a long name, a German string or a
              large text size wraps instead of clipping. */}
          <Text variant="subheadline">
            <Text variant="subheadline" style={styles.strong}>
              {name}
            </Text>
            {SEPARATOR}
            {result}
            {graded ? SEPARATOR : null}
            {graded ? (
              <Text variant="subheadline" style={styles.strong}>
                {graded}
              </Text>
            ) : null}
            <Text variant="subheadline" color={systemColors.secondaryLabel}>
              {SEPARATOR}
              {when}
              {earlierShort ? `${SEPARATOR}${earlierShort}` : null}
            </Text>
          </Text>
          {note ? (
            <Text variant="body" numberOfLines={noteLines}>
              {note}
            </Text>
          ) : null}
        </View>
      </PressableSurface>
      {/* A sibling of the row button, not a child: a button inside a button is
          unreachable for VoiceOver and TalkBack. */}
      {hasEarlier && onPressEarlier ? (
        <EarlierButton
          label={t('mobile.climberLogs.earlierDetail', {
            logs: t('mobile.climberLogs.earlierLogs', { count: earlier.length }),
            tries: t('mobile.logbook.tries', { count: group.earlierTries }),
            days: t('mobile.climberLogs.earlierDays', { count: group.earlierDays }),
          })}
          expanded={earlierExpanded}
          onPress={handlePressEarlier}
          inset
        />
      ) : null}
    </View>
  );
});

type BareCellProps = {
  group: ClimberLogGroup;
  boardAngle: number;
  climbGradeId: number | null;
  /** The cell sits under a "Tried, no send" heading, so it only says how many tries. */
  underTriedHeading: boolean;
  onPressClimber: (userId: string) => void;
};

/** A climber with nothing to add: face, name, how it went and when. Opens their profile. */
const BareCell = memo(function BareCell({
  group,
  boardAngle,
  climbGradeId,
  underTriedHeading,
  onPressClimber,
}: BareCellProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const logWords = useLogWords(boardAngle, climbGradeId);
  const { lead, userId } = group;
  const name = group.displayName ?? t('mobile.climberLogs.unknownClimber');
  const { result } = logWords(lead);
  const when = formatRelativeTime(lead.climbedAt);
  const tries = describeResult(lead);
  const shown =
    underTriedHeading && tries.kind === 'noSend' && lead.angle === boardAngle
      ? t('mobile.logbook.tries', { count: tries.tries })
      : result;

  const handlePress = useCallback(() => onPressClimber(userId), [onPressClimber, userId]);

  return (
    <PressableSurface
      onPress={handlePress}
      feedback="opacity"
      accessibilityRole="button"
      // The full words, heading or not: a screen reader may land here without it.
      accessibilityLabel={t('mobile.climberLogs.rowA11y', { name, result: `${result}, ${when}` })}
      style={styles.bareCell}
    >
      <Avatar uri={group.avatarUrl} name={name} size={BARE_AVATAR_SIZE} />
      <View style={styles.bareText}>
        <Text variant="subheadline" numberOfLines={1} style={styles.strong}>
          {name}
        </Text>
        <Text variant="footnote" numberOfLines={1} color={systemColors.secondaryLabel}>
          {shown}
          {SEPARATOR}
          {when}
        </Text>
      </View>
    </PressableSurface>
  );
});

type ClimberLogBareRowProps = {
  /** One or two climbers. Two share the line. */
  groups: readonly ClimberLogGroup[];
  /** One climber with earlier logs: the cell takes the line and "+N earlier" sits beside it. */
  wide: boolean;
  boardAngle: number;
  climbGradeId: number | null;
  underTriedHeading?: boolean;
  onPressClimber: (userId: string) => void;
  onPressEarlier?: (userId: string) => void;
  earlierExpanded?: boolean;
};

/** One line of the full list for climbers with nothing to add. */
export const ClimberLogBareRow = memo(function ClimberLogBareRow({
  groups,
  wide,
  boardAngle,
  climbGradeId,
  underTriedHeading = false,
  onPressClimber,
  onPressEarlier,
  earlierExpanded = false,
}: ClimberLogBareRowProps) {
  const { t } = useTranslation('session');
  const [first] = groups;
  const firstUserId = first?.userId;
  const handlePressEarlier = useCallback(() => {
    if (firstUserId) onPressEarlier?.(firstUserId);
  }, [onPressEarlier, firstUserId]);

  return (
    <View style={styles.bareRow}>
      {groups.map((group) => (
        <BareCell
          key={group.userId}
          group={group}
          boardAngle={boardAngle}
          climbGradeId={climbGradeId}
          underTriedHeading={underTriedHeading}
          onPressClimber={onPressClimber}
        />
      ))}
      {wide && first && onPressEarlier ? (
        <EarlierButton
          label={t('mobile.climberLogs.earlierShort', { count: first.earlier.length })}
          accessibilityLabel={t('mobile.climberLogs.earlierA11y', {
            name: first.displayName ?? t('mobile.climberLogs.unknownClimber'),
            logs: t('mobile.climberLogs.earlierLogs', { count: first.earlier.length }),
          })}
          expanded={earlierExpanded}
          onPress={handlePressEarlier}
        />
      ) : null}
    </View>
  );
});

/** One of a climber's other logs, shown in place under their row in the full list. */
export const ClimberLogEarlierRow = memo(function ClimberLogEarlierRow({
  log,
  boardAngle,
  climbGradeId,
}: {
  log: ClimberLog;
  boardAngle: number;
  climbGradeId: number | null;
}) {
  const { systemColors } = useTheme();
  const logWords = useLogWords(boardAngle, climbGradeId);
  const note = log.comment.trim();
  const { result, graded } = logWords(log);

  return (
    <View style={[styles.earlierRow, { borderLeftColor: systemColors.separator }]}>
      <View style={styles.earlierLine}>
        <Text variant="subheadline" style={styles.earlierWords}>
          {result}
          {graded ? SEPARATOR : null}
          {graded ? (
            <Text variant="subheadline" style={styles.strong}>
              {graded}
            </Text>
          ) : null}
        </Text>
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {formatRelativeTime(log.climbedAt)}
        </Text>
      </View>
      {note ? (
        <Text variant="subheadline" color={systemColors.secondaryLabel}>
          {note}
        </Text>
      ) : null}
    </View>
  );
});

/** A climber's plain one-try repeat sends at one angle, as one line instead of one each. */
export const ClimberLogEarlierFoldRow = memo(function ClimberLogEarlierFoldRow({
  angle,
  count,
  boardAngle,
}: {
  angle: number;
  count: number;
  boardAngle: number;
}) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  return (
    <View style={[styles.earlierRow, { borderLeftColor: systemColors.separator }]}>
      <Text variant="subheadline" color={systemColors.secondaryLabel}>
        {angle === boardAngle
          ? t('mobile.climberLogs.foldSends', { count })
          : t('mobile.climberLogs.foldSendsAtAngle', { count, angle })}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    minHeight: 52,
  },
  pressable: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing[3],
    paddingVertical: spacing[2],
    minHeight: 52,
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  strong: {
    fontWeight: '600',
  },
  earlierButton: {
    minHeight: MIN_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
  },
  earlierButtonInset: {
    marginLeft: AVATAR_SIZE + spacing[3],
  },
  bareRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  bareCell: {
    flex: 1,
    minWidth: 0,
    minHeight: BARE_CELL_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  bareText: {
    flex: 1,
    minWidth: 0,
  },
  earlierRow: {
    marginLeft: AVATAR_SIZE / 2,
    paddingLeft: AVATAR_SIZE / 2 + spacing[3],
    paddingVertical: spacing[1],
    borderLeftWidth: StyleSheet.hairlineWidth,
  },
  earlierLine: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing[2],
  },
  earlierWords: {
    flex: 1,
    minWidth: 0,
  },
});
