import { memo, useCallback } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import type { RecentFilter } from '../../lib/recent-filter-store';
import { hapticSelection } from '../../lib/haptics';
import { spacing } from '../../theme/tokens';
import { GRADE_CHIP_HEIGHT, GradeChip } from '../grade/GradeChip';

// A long saved search ("V4–V6 · Benchmarks · Unsent…") truncates rather than
// growing one chip wider than the sheet.
const MAX_CHIP_WIDTH = 240;

type RecentSearchRailProps = {
  /** The saved searches, newest first (at most 10, so no virtualisation). */
  recents: readonly RecentFilter[];
  /** The saved search in force now, marked like a selected grade chip. */
  currentId?: string;
  /** Applies the saved search with this id; keep it stable across renders. */
  onSelect: (id: string) => void;
  contentInsetLeft?: number;
  contentInsetRight?: number;
  style?: StyleProp<ViewStyle>;
};

type RecentSearchChipProps = {
  recent: RecentFilter;
  current: boolean;
  onSelect: (id: string) => void;
};

const RecentSearchChip = memo(function RecentSearchChip({ recent, current, onSelect }: RecentSearchChipProps) {
  const { id, label } = recent;
  const handlePress = useCallback(() => {
    hapticSelection();
    onSelect(id);
  }, [id, onSelect]);
  return (
    <GradeChip
      label={label}
      tone={current ? 'selected' : 'neutral'}
      onPress={handlePress}
      accessibilityLabel={label}
      accessibilityState={{ selected: current }}
      style={styles.chip}
    />
  );
});

/**
 * The saved searches as a strip of chips under Recent in Filters: the grade
 * rail's chips and horizontal scroll, one chip per search. A tap applies that
 * search, the same as picking it from the toolbar's Recent menu.
 */
export const RecentSearchRail = memo(function RecentSearchRail({
  recents,
  currentId,
  onSelect,
  contentInsetLeft = spacing[4],
  contentInsetRight = spacing[4],
  style,
}: RecentSearchRailProps) {
  return (
    <View style={style}>
      <ScrollView
        horizontal
        nestedScrollEnabled={Platform.OS === 'android'}
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        style={styles.railScroll}
        contentContainerStyle={[styles.railContent, { paddingStart: contentInsetLeft, paddingEnd: contentInsetRight }]}
      >
        {recents.map((recent) => (
          <RecentSearchChip key={recent.id} recent={recent} current={recent.id === currentId} onSelect={onSelect} />
        ))}
      </ScrollView>
    </View>
  );
});

const styles = StyleSheet.create({
  chip: {
    maxWidth: MAX_CHIP_WIDTH,
  },
  // Same strip as the grade rail (grade/RangeRail.tsx): flexGrow 0 and the min
  // height keep it from collapsing inside the native bottom sheet.
  railScroll: {
    flexGrow: 0,
  },
  railContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    minHeight: GRADE_CHIP_HEIGHT + spacing[1] * 2,
    paddingVertical: spacing[1],
  },
});
