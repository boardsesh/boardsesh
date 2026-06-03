// Bottom-bar search layout: a floating card pinned in the thumb zone above the
// queue bar / tab bar. Grade lives where the hand already rests (the two RN-UX
// judges' pick). The climber can switch to the sticky-strip layout in Settings.

import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeIn, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import type { Grade } from '@boardsesh/shared-schema';
import type { GradeBound, ClimbBoardFilterState } from '@boardsesh/climb-filters';
import { useTheme } from '../../providers/theme-provider';
import { shadowColor } from '../../theme/tokens';
import type { ClimbFilters } from '../../lib/climb-filter-types';
import { ClimbSearchControls } from './ClimbSearchControls';

type SearchBottomBarProps = {
  bound: GradeBound;
  grades: readonly Grade[];
  filters: ClimbFilters;
  boardFilters: ClimbBoardFilterState;
  count: number | undefined;
  activeFilterCount: number;
  onOpenGrade: () => void;
  onOpenFilters: () => void;
  onPatchFilters: (patch: Partial<ClimbFilters>) => void;
  onPatchBoardFilters: (patch: Partial<ClimbBoardFilterState>) => void;
  /** Distance from the bottom of the screen (clears the queue + tab bars). */
  bottomOffset: number;
};

export function SearchBottomBar({ bottomOffset, ...controls }: SearchBottomBarProps) {
  const { systemColors } = useTheme();

  // Slide the bar up/down in sync with the queue bar fading in/out, rather than
  // snapping by ~64px when a climb becomes/stops being active.
  const offset = useSharedValue(bottomOffset);
  useEffect(() => {
    offset.value = withTiming(bottomOffset, { duration: 200 });
  }, [bottomOffset, offset]);
  const animatedStyle = useAnimatedStyle(() => ({ bottom: offset.value }));

  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      style={[styles.bar, { backgroundColor: systemColors.elevatedSurface as string }, animatedStyle]}
    >
      <View style={styles.inner}>
        <ClimbSearchControls {...controls} />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 8,
    right: 8,
    borderRadius: 14,
    overflow: 'hidden',
    shadowColor,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 10,
    elevation: 6,
  },
  inner: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
});
