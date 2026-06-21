import { useEffect, useMemo } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import type { Grade } from '@boardsesh/shared-schema';
import type { GradeBound } from '@boardsesh/climb-filters';
import { spacing } from '../../theme/tokens';
import { timingFor } from '../../theme/motion-config';
import { useTheme } from '../../providers/theme-provider';
import { FILTER_FAB_SIZE, FilterButton } from './FilterButton';
import { GradeRangeRail } from '../grade';

type ClimbFilterFabProps = {
  activeFilterCount: number;
  bottom: number;
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
  bound,
  grades,
  gradeRailVisible,
  onOpenFilters,
  onOpenGrade,
  onCloseGrade,
  onGradeChange,
}: ClimbFilterFabProps) {
  const { motion } = useTheme();
  const animatedBottom = useSharedValue(bottom);

  // The FAB slot slides when the grade rail opens/closes — a layout move, so
  // emphasized motion (M3 easing + 350ms on Material; the prior 250ms on glass).
  // Memoised so the slide effect re-fires only on a real `bottom` change, not on
  // every theme recompute (e.g. a colour-scheme flip).
  const slideTiming = useMemo(() => timingFor(motion.emphasized), [motion]);

  useEffect(() => {
    animatedBottom.value = withTiming(bottom, slideTiming);
  }, [animatedBottom, bottom, slideTiming]);

  const fabSlotStyle = useAnimatedStyle(() => ({ bottom: animatedBottom.value }));
  const gradeRailSlotStyle = useAnimatedStyle(() => ({
    bottom: animatedBottom.value + FILTER_FAB_SIZE + spacing[2],
  }));

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
        <Animated.View pointerEvents="box-none" style={[styles.gradeRailSlot, gradeRailSlotStyle]}>
          <GradeRangeRail grades={grades} bound={bound} onChange={onGradeChange} onRequestClose={onCloseGrade} />
        </Animated.View>
      ) : null}
      <Animated.View pointerEvents="box-none" style={[styles.fabSlot, fabSlotStyle]}>
        <FilterButton
          activeFilterCount={activeFilterCount}
          onPress={onOpenFilters}
          onLongPress={onOpenGrade}
          prominence="floating"
        />
      </Animated.View>
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
    bottom: 0,
    zIndex: 20,
  },
  fabSlot: {
    position: 'absolute',
    right: spacing[6] + spacing[1],
    zIndex: 21,
  },
});
