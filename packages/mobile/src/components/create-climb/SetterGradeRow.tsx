import { useCallback, useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { GradeSingleSelectRail } from '../grade';
import { useGrades } from '../../lib/graphql/hooks';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';

const RAIL_HEIGHT = 56;
/** Keeps the last chip short of the screen edge so the rail reads as scrollable. */
const RAIL_TRAIL_INSET = spacing[6];

type SetterGradeRowProps = {
  boardName: string;
  /** The picked difficulty id, or null while the setter has not graded the climb. */
  difficultyId: number | null;
  onSelect: (difficultyId: number | null) => void;
  /** True while publishing is selected and the grade is the thing stopping it. */
  required: boolean;
};

/**
 * "Your grade" — the setter's own grade for a climb on a board that has no crowd
 * grade to fall back on (a spray wall, #5443).
 *
 * Required to publish, optional on a draft: the grade is the last thing a setter
 * decides, and a draft that cannot be saved without one would be a draft you
 * cannot leave. The subtitle says which of the two you are in, so a disabled Save
 * is never the first time you hear about it.
 *
 * The rail is the same control the tick sheets use to pick one grade, on the same
 * scale the server grades against (`board_difficulty_grades` for the board, which
 * `useGrades` reads and falls back to the bundled taxonomy for offline).
 */
export function SetterGradeRow({ boardName, difficultyId, onSelect, required }: SetterGradeRowProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const { data: grades } = useGrades(boardName);
  const { formatGrade } = useGradeFormat();

  const handleSelect = useCallback(
    (nextDifficultyId: number | undefined) => onSelect(nextDifficultyId ?? null),
    [onSelect],
  );

  const selectedLabel = useMemo(() => {
    if (difficultyId == null) return null;
    const picked = grades?.find((grade) => grade.difficultyId === difficultyId);
    return picked ? formatGrade(picked.name) : null;
  }, [grades, difficultyId, formatGrade]);

  return (
    <View style={styles.row}>
      <View style={styles.heading}>
        <Text variant="footnote" style={styles.label}>
          {t('mobile.create.grade.label')}
        </Text>
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {selectedLabel ?? (required ? t('mobile.create.grade.required') : t('mobile.create.grade.optional'))}
        </Text>
      </View>
      <View style={styles.rail}>
        <GradeSingleSelectRail
          grades={grades ?? []}
          selectedDifficultyId={difficultyId}
          onSelect={handleSelect}
          // No clear: `updateClimb` has no way to un-grade a climb, so offering
          // the gesture would be an action the server cannot carry out. Moving
          // the grade is the only edit there is.
          allowClear={false}
          colorway="selection"
          contentInsetLeft={spacing[4]}
          contentInsetRight={RAIL_TRAIL_INSET}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    gap: spacing[2],
  },
  heading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing[2],
  },
  label: {
    opacity: 0.6,
  },
  // Bleeds to the drawer edges, like the switch group below it, so the rail can
  // be scrolled from the screen edge rather than from inside a gutter.
  rail: {
    marginHorizontal: -spacing[4],
    height: RAIL_HEIGHT,
  },
});
