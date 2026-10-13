// The inline rail the Logbook's capsule row drops below itself while its Grade
// or Angle capsule is open. One rail at a time; the capsule toggles it and the
// Logbook tab owns which is open. Both are the same pickers the filter sheet
// uses (GradeRangeRail, AngleRangeRail), so a facet never behaves two ways.
// Commits are live: each change patches the filters straight away.

import { memo, useCallback, useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import type { GradeBound } from '@boardsesh/climb-filters';
import type { LogbookFilterState } from '@boardsesh/logbook';
import type { Grade } from '@boardsesh/shared-schema';
import { GradeRangeRail } from '../grade';
import { AngleRangeRail } from '../filter-sheet/AngleRangeRail';
import { logbookAnglePatch, logbookAngleRailValue, type LogbookRailKind } from './logbook-capsules';
import { spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { useFloatingHeaderControls } from '../../hooks/use-floating-header-controls';

type LogbookFacetRailProps = {
  /** Which rail to show; null renders nothing. */
  openRail: LogbookRailKind | null;
  filters: LogbookFilterState;
  /** The grade scale the sheet's rail uses too. */
  grades: readonly Grade[];
  /** Live-commit a partial filter patch. */
  onUpdateFilters: (partial: Partial<LogbookFilterState>) => void;
};

function LogbookFacetRailComponent({ openRail, filters, grades, onUpdateFilters }: LogbookFacetRailProps) {
  const { systemColors } = useTheme();
  const glassGradeRail = useFloatingHeaderControls() && openRail === 'grade';
  const gradeBound = useMemo<GradeBound>(
    () => ({
      minGradeId: filters.minGrade === '' ? undefined : filters.minGrade,
      maxGradeId: filters.maxGrade === '' ? undefined : filters.maxGrade,
    }),
    [filters.minGrade, filters.maxGrade],
  );
  const angleValue = useMemo(() => logbookAngleRailValue(filters.angleRange), [filters.angleRange]);

  const handleGradeChange = useCallback(
    (bound: GradeBound) => onUpdateFilters({ minGrade: bound.minGradeId ?? '', maxGrade: bound.maxGradeId ?? '' }),
    [onUpdateFilters],
  );
  const handleAngleChange = useCallback(
    (next: [number, number] | null) => onUpdateFilters(logbookAnglePatch(next)),
    [onUpdateFilters],
  );

  if (openRail === null) return null;

  // The capsule row pads its first capsule 16pt in from the column's edge, and
  // the rails' default insets do the same, so both strips start on one line
  // and scroll out to the column's edge.
  return (
    <View
      testID="logbook-facet-rail"
      style={[styles.rail, glassGradeRail ? null : { backgroundColor: systemColors.background }]}
    >
      {openRail === 'grade' ? (
        <GradeRangeRail
          glass={glassGradeRail}
          grades={grades}
          bound={gradeBound}
          onChange={handleGradeChange}
          centerOnEmpty={false}
        />
      ) : (
        <AngleRangeRail value={angleValue} onChange={handleAngleChange} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  rail: {
    paddingBottom: spacing[2],
  },
});

export const LogbookFacetRail = memo(LogbookFacetRailComponent);
