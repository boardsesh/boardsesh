// The inline rail the logbook chip row drops below itself when a grade/angle/date
// facet chip is open (the iOS-glass branch only — mounted by LogbookTab under the
// SwiftUI Host). One facet open at a time; the chip toggles it. Every control is
// the SAME one the LogbookFilterSheet uses (GradeRangeRail, LogbookAngleRail,
// DateRangeRow), so a facet is never worded or behaves two ways. Commits are
// live: each change calls setFilters straight away (no draft/apply).

import { memo, useCallback, useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { GradeBound } from '@boardsesh/climb-filters';
import type { LogbookFilterState } from '@boardsesh/logbook';
import type { Grade } from '@boardsesh/shared-schema';
import { GradeRangeRail } from '../grade';
import { LogbookAngleRail, DateRangeRow } from './logbook-facet-controls';
import type { LogbookFacetKey } from './LogbookChipRow.logic';
import { spacing } from '../../theme/tokens';

type LogbookFacetRailProps = {
  /** Which facet's rail to show; null renders nothing. */
  openFacet: LogbookFacetKey | null;
  filters: LogbookFilterState;
  /** Grade scale (difficultyId → name) for the grade rail (same as the sheet). */
  grades: readonly Grade[];
  /** Live-commit a partial filter patch. */
  onUpdateFilters: (partial: Partial<LogbookFilterState>) => void;
  /** A stable "today" ceiling for the To-date row's maximumDate. */
  today: Date;
};

function LogbookFacetRailComponent({ openFacet, filters, grades, onUpdateFilters, today }: LogbookFacetRailProps) {
  const { t } = useTranslation('you');

  const gradeBound = useMemo<GradeBound>(
    () => ({
      minGradeId: filters.minGrade === '' ? undefined : filters.minGrade,
      maxGradeId: filters.maxGrade === '' ? undefined : filters.maxGrade,
    }),
    [filters.minGrade, filters.maxGrade],
  );

  const handleGradeChange = useCallback(
    (bound: GradeBound) => onUpdateFilters({ minGrade: bound.minGradeId ?? '', maxGrade: bound.maxGradeId ?? '' }),
    [onUpdateFilters],
  );
  const handleAngleRange = useCallback(
    (angleRange: [number, number]) => onUpdateFilters({ angleRange }),
    [onUpdateFilters],
  );
  const handleFromDate = useCallback((iso: string) => onUpdateFilters({ fromDate: iso }), [onUpdateFilters]);
  const handleToDate = useCallback((iso: string) => onUpdateFilters({ toDate: iso }), [onUpdateFilters]);

  if (openFacet === null) return null;

  return (
    <View style={styles.rail}>
      {openFacet === 'grade' ? (
        <GradeRangeRail
          grades={grades}
          bound={gradeBound}
          onChange={handleGradeChange}
          dismissible={false}
          centerOnEmpty={false}
        />
      ) : null}

      {openFacet === 'angle' ? <LogbookAngleRail angleRange={filters.angleRange} onChange={handleAngleRange} /> : null}

      {openFacet === 'date' ? (
        <>
          <DateRangeRow
            label={t('mobile.logbook.dateFrom')}
            value={filters.fromDate}
            onChange={handleFromDate}
            clearLabel={t('mobile.logbook.dateAny')}
          />
          <View style={styles.dateRowGap} />
          <DateRangeRow
            label={t('mobile.logbook.dateTo')}
            value={filters.toDate}
            onChange={handleToDate}
            clearLabel={t('mobile.logbook.dateAny')}
            maximumDate={today}
          />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  rail: {
    paddingTop: spacing[2],
  },
  dateRowGap: {
    height: spacing[2],
  },
});

export const LogbookFacetRail = memo(LogbookFacetRailComponent);
