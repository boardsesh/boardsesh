import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import { BOULDER_GRADES } from '@boardsesh/board-constants/boulder-grade-mapping';
import { Text } from '../Text';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, borderRadius } from '../../theme/tokens';

type GradePillProps = {
  /** The grade a climber gave. Nullish renders nothing. */
  difficultyId: number | null | undefined;
};

// Canonical difficulty_id → "6a/V3" name, which always carries both scales so
// the grade color resolves regardless of the user's display-format preference.
const GRADE_NAME_BY_DIFFICULTY_ID = new Map<number, string>(
  BOULDER_GRADES.map((grade) => [grade.difficulty_id, grade.difficulty_name]),
);

/** The grade a climber gave a log, in their display format and its grade colour. */
export const GradePill = memo(function GradePill({ difficultyId }: GradePillProps) {
  const { formatGradeByDifficultyId } = useGradeFormat();
  const label = formatGradeByDifficultyId(difficultyId);
  if (difficultyId == null || !label) return null;

  // Color keys off the raw difficulty id (via its canonical name), not the
  // display-formatted label, so a "V6 / 7a" combined-format label still paints
  // the right color. Falls back for unknown ids.
  const difficultyName = GRADE_NAME_BY_DIFFICULTY_ID.get(difficultyId);
  const color = (difficultyName ? getGradeColor(difficultyName) : undefined) ?? DEFAULT_GRADE_COLOR;

  return (
    <View style={styles.pill}>
      <Text variant="caption2" color={color} style={styles.label}>
        {label}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  pill: {
    paddingHorizontal: spacing[2],
    paddingVertical: 1,
    borderRadius: borderRadius.full,
    backgroundColor: `${iosSystemColors.systemGray}1F`,
  },
  label: {
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
});
