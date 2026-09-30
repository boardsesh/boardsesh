import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '../src/auth/auth-provider';
import { useBoard } from '../src/board/board-provider';
import {
  DEFAULT_CLIMB_FILTERS,
  SORT_LABELS,
  withSort,
  type ClimbFilters,
  type ClimbSort,
} from '../src/climbs/climb-filters';
import { useClimbFilters } from '../src/climbs/climb-filters-provider';
import { useSessionClimbs } from '../src/climbs/use-session-climbs';
import { bandColor, gradeBandFromId, gradeOptions } from '../src/grades/grades';
import { useDebouncedValue } from '../src/hooks/use-debounced-value';
import { usePreferences } from '../src/settings/preferences-provider';
import { Button } from '../src/ui/Button';
import { Checkbox } from '../src/ui/Checkbox';
import { SegmentedControl } from '../src/ui/SegmentedControl';
import { Stepper } from '../src/ui/Stepper';
import { Text } from '../src/ui/Text';
import { Sheet } from '../src/ui/Sheet';
import { useTheme } from '../src/ui/theme';
import { spacing } from '../src/ui/tokens';

// Six sorts don't fit one strip: two strips of three share one choice.
const SORT_ROWS: readonly (readonly ClimbSort[])[] = [
  ['popular', 'quality', 'newest'],
  ['easiest', 'hardest', 'random'],
];
const SHORT_SORT: Record<ClimbSort, string> = {
  popular: 'Sends',
  quality: 'Stars',
  newest: 'Newest',
  easiest: 'Easiest',
  hardest: 'Hardest',
  random: 'Shuffle',
};
const STAR_MINIMUMS = [1, 2, 3, 4];

/** Filters apply as you change them; the button shows how many climbs are left. */
export default function FiltersSheet() {
  const theme = useTheme();
  const { filters, setFilters, query } = useClimbFilters();
  const { board } = useBoard();
  const { status } = useAuth();
  const { gradeFormat } = usePreferences();
  // Same query as the Session list, so the count comes from its cache.
  const { total } = useSessionClimbs(board, filters, useDebouncedValue(query, 300));
  const grades = board ? gradeOptions(board.boardName, gradeFormat) : [];
  const update = (changes: Partial<ClimbFilters>) => setFilters({ ...filters, ...changes });

  // Grade bounds are steppers over the board's grade list. Stepping past either
  // end means "any", and the two bounds never cross.
  const indexOf = (difficultyId: number | null, fallback: number) => {
    const index = grades.findIndex((grade) => grade.difficultyId === difficultyId);
    return index >= 0 ? index : fallback;
  };
  const minIndex = filters.minGrade === null ? -1 : indexOf(filters.minGrade, -1);
  const maxIndex = filters.maxGrade === null ? grades.length : indexOf(filters.maxGrade, grades.length);
  const setMinIndex = (index: number) =>
    update({
      minGrade: index < 0 ? null : grades[index].difficultyId,
      maxGrade: index >= 0 && maxIndex < index ? grades[index].difficultyId : filters.maxGrade,
    });
  const setMaxIndex = (index: number) =>
    update({
      maxGrade: index >= grades.length ? null : grades[index].difficultyId,
      minGrade: index < grades.length && minIndex > index ? grades[index].difficultyId : filters.minGrade,
    });

  return (
    <Sheet
      title="Filters"
      gap={22}
      footer={
        <>
          <Button title="Reset" variant="ghost" size="lg" onPress={() => setFilters(DEFAULT_CLIMB_FILTERS)} />
          <Button
            title={total !== undefined ? `Show ${total.toLocaleString()} climbs` : 'Show climbs'}
            size="lg"
            style={styles.flex}
            onPress={() => router.back()}
          />
        </>
      }
    >
      <View style={styles.field}>
        <Text variant="label">Grades</Text>
        <Stepper
          label="From"
          showLabel
          value={minIndex}
          min={-1}
          max={grades.length - 1}
          onChange={setMinIndex}
          format={(index) => (index < 0 ? 'Any' : (grades[index]?.label ?? 'Any'))}
          valueColor={bandColor(theme.grades, gradeBandFromId(grades[minIndex]?.difficultyId))}
        />
        <Stepper
          label="To"
          showLabel
          value={maxIndex}
          min={0}
          max={grades.length}
          onChange={setMaxIndex}
          format={(index) => (index >= grades.length ? 'Any' : (grades[index]?.label ?? 'Any'))}
          valueColor={bandColor(theme.grades, gradeBandFromId(grades[maxIndex]?.difficultyId))}
        />
      </View>

      <View style={styles.field}>
        <Text variant="label">Sort by</Text>
        {SORT_ROWS.map((row) => (
          <SegmentedControl
            key={row.join()}
            fullWidth
            size="lg"
            value={filters.sort}
            onChange={(sort) => setFilters(withSort(filters, sort))}
            options={row.map((sort) => ({
              value: sort,
              label: SHORT_SORT[sort],
              accessibilityLabel: SORT_LABELS[sort],
            }))}
          />
        ))}
      </View>

      <View style={styles.field}>
        <Text variant="label">Stars</Text>
        <SegmentedControl
          fullWidth
          size="lg"
          value={filters.minStars ?? 0}
          onChange={(stars) => update({ minStars: stars === 0 ? null : stars })}
          options={[
            { value: 0, label: 'Any' },
            ...STAR_MINIMUMS.map((stars) => ({
              value: stars,
              label: `★${stars}+`,
              accessibilityLabel: `At least ${stars} stars`,
            })),
          ]}
        />
      </View>

      <View style={styles.checks}>
        <Checkbox
          label="Benchmarks only"
          description={
            board?.boardName === 'moonboard' ? 'The MoonBoard benchmark problems' : "The board's official graded set"
          }
          checked={filters.benchmarksOnly}
          onChange={(benchmarksOnly) => update({ benchmarksOnly })}
        />
        <Checkbox
          label="Hide what I've sent"
          description={status === 'signedIn' ? undefined : 'Sign in to use this'}
          checked={filters.hideSent && status === 'signedIn'}
          disabled={status !== 'signedIn'}
          onChange={(hideSent) => update({ hideSent })}
        />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  field: { gap: spacing.sm },
  checks: { gap: spacing.lg },
});
