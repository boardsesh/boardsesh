import { useCallback, useEffect, useMemo } from 'react';
import { View, StyleSheet, type LayoutChangeEvent } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
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
/** One half-beat of the "Needed to publish" pulse; a prompt is two full beats. */
const PULSE_HALF_BEAT_MS = 160;
const PULSE_DIM_OPACITY = 0.25;

type SetterGradeRowProps = {
  boardName: string;
  /** The picked difficulty id, or null while the setter has not graded the climb. */
  difficultyId: number | null;
  onSelect: (difficultyId: number | null) => void;
  /** True while publishing is selected and the grade is still missing. */
  required: boolean;
  /**
   * Bumped each time Save is tapped while the grade is what is missing; 0 when no
   * prompt is outstanding. While it is non-zero the "Needed to publish" subtitle
   * takes the warning colour, and every bump pulses it — the drawer has just
   * scrolled here, and the pulse is what says why.
   */
  highlightSignal?: number;
  /** Where the row sits in the form, so the drawer can scroll it into view. */
  onLayout?: (event: LayoutChangeEvent) => void;
};

/**
 * "Your grade" — the setter's own grade for a climb on a board that has no crowd
 * grade to fall back on (a spray wall, #5443).
 *
 * Required to publish, optional on a draft: the grade is the last thing a setter
 * decides, and a draft that cannot be saved without one would be a draft you
 * cannot leave. The subtitle says which of the two you are in. Save is NOT
 * disabled by a missing grade (#5954): tapping it brings this row into view with
 * the subtitle highlighted, since the row sits below the fold and a dead button
 * up there gave no hint where to look.
 *
 * The rail is the same control the tick sheets use to pick one grade, on the same
 * scale the server grades against (`board_difficulty_grades` for the board, which
 * `useGrades` reads and falls back to the bundled taxonomy for offline).
 */
export function SetterGradeRow({
  boardName,
  difficultyId,
  onSelect,
  required,
  highlightSignal = 0,
  onLayout,
}: SetterGradeRowProps) {
  const { t } = useTranslation('climbs');
  const { systemColors, brandColors } = useTheme();
  const reduceMotion = useReducedMotion();
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

  const prompted = required && highlightSignal > 0 && selectedLabel === null;

  // Two beats per Save tap. Reduced motion keeps the colour change and drops the
  // movement — the warning colour alone still answers the tap.
  const subtitleOpacity = useSharedValue(1);
  useEffect(() => {
    if (highlightSignal === 0 || reduceMotion) return;
    subtitleOpacity.value = withSequence(
      withTiming(PULSE_DIM_OPACITY, { duration: PULSE_HALF_BEAT_MS }),
      withTiming(1, { duration: PULSE_HALF_BEAT_MS }),
      withTiming(PULSE_DIM_OPACITY, { duration: PULSE_HALF_BEAT_MS }),
      withTiming(1, { duration: PULSE_HALF_BEAT_MS }),
    );
  }, [highlightSignal, reduceMotion, subtitleOpacity]);
  const subtitleStyle = useAnimatedStyle(() => ({ opacity: subtitleOpacity.value }));

  return (
    <View style={styles.row} onLayout={onLayout}>
      <View style={styles.heading}>
        <Text variant="footnote" style={styles.label}>
          {t('mobile.create.grade.label')}
        </Text>
        <Animated.View style={subtitleStyle}>
          <Text
            variant="footnote"
            color={prompted ? brandColors.warning : systemColors.secondaryLabel}
            testID="setter-grade-subtitle"
          >
            {selectedLabel ?? (required ? t('mobile.create.grade.required') : t('mobile.create.grade.optional'))}
          </Text>
        </Animated.View>
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
