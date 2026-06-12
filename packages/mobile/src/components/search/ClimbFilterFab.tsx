import { Pressable, StyleSheet, View } from 'react-native';
import type { Grade } from '@boardsesh/shared-schema';
import type { GradeBound } from '@boardsesh/climb-filters';
import type { FilterToken } from '../../lib/filter-tokens';
import { spacing } from '../../theme/tokens';
import { FILTER_FAB_SIZE, FilterButton } from './FilterButton';
import { GradeRangeRail } from '../grade';
import { ActiveFilterStrip } from './ActiveFilterStrip';

type ClimbFilterFabProps = {
  activeFilterCount: number;
  bottom: number;
  totalCount?: number;
  filterTokens?: readonly FilterToken[];
  bound: GradeBound;
  grades: readonly Grade[];
  gradeRailVisible: boolean;
  onOpenFilters: () => void;
  onOpenGrade: () => void;
  onCloseGrade: () => void;
  onGradeChange: (grade: GradeBound) => void;
};

export function ClimbFilterFab({
  activeFilterCount,
  bottom,
  totalCount,
  filterTokens = [],
  bound,
  grades,
  gradeRailVisible,
  onOpenFilters,
  onOpenGrade,
  onCloseGrade,
  onGradeChange,
}: ClimbFilterFabProps) {
  const showFilterStrip = !gradeRailVisible && (totalCount != null || filterTokens.length > 0);

  return (
    <>
      {gradeRailVisible ? (
        <Pressable
          style={styles.dismissLayer}
          onPress={onCloseGrade}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
      ) : null}
      {gradeRailVisible ? (
        <View
          pointerEvents="box-none"
          style={[styles.gradeRailSlot, { bottom: bottom + FILTER_FAB_SIZE + spacing[2] }]}
        >
          <GradeRangeRail grades={grades} bound={bound} onChange={onGradeChange} onRequestClose={onCloseGrade} />
        </View>
      ) : null}
      {showFilterStrip ? (
        <View
          pointerEvents="box-none"
          style={[styles.filterStripSlot, { bottom: bottom + FILTER_FAB_SIZE + spacing[2] }]}
        >
          <ActiveFilterStrip totalCount={totalCount} tokens={filterTokens} align="end" />
        </View>
      ) : null}
      <View pointerEvents="box-none" style={[styles.fabSlot, { bottom }]}>
        <FilterButton activeFilterCount={activeFilterCount} onPress={onOpenFilters} onLongPress={onOpenGrade} />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  dismissLayer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 15,
  },
  gradeRailSlot: {
    position: 'absolute',
    left: spacing[4],
    right: spacing[4],
    zIndex: 20,
  },
  filterStripSlot: {
    position: 'absolute',
    left: spacing[4],
    right: spacing[4],
    zIndex: 20,
  },
  fabSlot: {
    position: 'absolute',
    right: spacing[6] + spacing[1],
    zIndex: 21,
  },
});
