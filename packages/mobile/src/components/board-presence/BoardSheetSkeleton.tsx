// Skeleton ("shadow") placeholders for the board-presence sheet. Shown while the
// feed is hydrating on first open and while a manual refresh is in flight, so the
// stats tiles and history list don't pop in (or show the empty state) before data
// lands. Static-opacity blocks tinted with `systemColors.fill`, matching
// ClimbListRowSkeleton — no shimmer dependency. Dimensions mirror the real stat
// tiles (styles.statTiles / statTile) and history rows (styles.historyRow).

import { View, StyleSheet } from 'react-native';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius } from '../../theme/tokens';

const STAT_TILE_COUNT = 4;
const HISTORY_ROW_COUNT = 5;

export function BoardSheetStatsSkeleton() {
  const { systemColors } = useTheme();
  const blockColor = systemColors.fill;

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="board-sheet-stats-skeleton"
      style={styles.statsBlock}
    >
      <View style={[styles.sectionHeaderBlock, { backgroundColor: blockColor }]} />
      <View style={styles.statTiles}>
        {Array.from({ length: STAT_TILE_COUNT }, (_, tileIndex) => (
          <View key={tileIndex} style={[styles.statTile, { backgroundColor: systemColors.secondaryBackground }]}>
            <View style={[styles.statValueBlock, { backgroundColor: blockColor }]} />
            <View style={[styles.statLabelBlock, { backgroundColor: blockColor }]} />
          </View>
        ))}
      </View>
    </View>
  );
}

export function BoardSheetHistorySkeleton() {
  const { systemColors } = useTheme();
  const blockColor = systemColors.fill;

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="board-sheet-history-skeleton"
    >
      <View style={[styles.sectionHeaderBlock, { backgroundColor: blockColor }]} />
      {Array.from({ length: HISTORY_ROW_COUNT }, (_, rowIndex) => (
        <View key={rowIndex} style={styles.historyRow}>
          <View style={styles.historyBody}>
            <View style={[styles.historyNameBlock, { backgroundColor: blockColor }]} />
            <View style={[styles.historySubBlock, { backgroundColor: blockColor }]} />
          </View>
          <View style={[styles.historyGradeBlock, { backgroundColor: blockColor }]} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  sectionHeaderBlock: {
    width: 96,
    height: 12,
    borderRadius: borderRadius.full,
    opacity: 0.4,
    marginHorizontal: spacing[4],
    marginTop: spacing[3],
    marginBottom: spacing[2],
  },
  statsBlock: {
    paddingBottom: spacing[2],
  },
  statTiles: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing[2],
    paddingHorizontal: spacing[4],
  },
  statTile: {
    flexGrow: 1,
    flexBasis: '47%',
    paddingVertical: spacing[3],
    paddingHorizontal: spacing[3],
    borderRadius: borderRadius.md,
    // Match styles.statTile in BoardSheet so tiles don't jump when real data lands.
    gap: 2,
  },
  statValueBlock: {
    width: 40,
    height: 22,
    borderRadius: borderRadius.full,
    opacity: 0.55,
  },
  statLabelBlock: {
    width: 56,
    height: 11,
    borderRadius: borderRadius.full,
    opacity: 0.4,
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  historyBody: {
    flex: 1,
    // Match styles.historyBody in BoardSheet so rows don't jump when real data lands.
    gap: 2,
  },
  historyNameBlock: {
    width: '62%',
    height: 16,
    borderRadius: borderRadius.full,
    opacity: 0.55,
  },
  historySubBlock: {
    width: '40%',
    height: 11,
    borderRadius: borderRadius.full,
    opacity: 0.4,
  },
  historyGradeBlock: {
    width: 34,
    height: 18,
    borderRadius: borderRadius.full,
    opacity: 0.5,
  },
});
