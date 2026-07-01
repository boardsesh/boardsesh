import { useMemo } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { type UnifiedTimeframeType, type RawLayoutPercentage } from '@boardsesh/profile-stats';
import { formatBoardDisplayName } from '@boardsesh/board-config';
import { SegmentedControl } from '../SegmentedControl';
import { Text } from '../Text';
import { spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

type ProgressControlBarProps = {
  timeframe: UnifiedTimeframeType;
  onSelectTimeframe: (timeframe: UnifiedTimeframeType) => void;
  selectedBoard: string;
  onSelectBoard: (board: string) => void;
  hasActiveFilters: boolean;
  onReset: () => void;
  layoutPercentages: RawLayoutPercentage[];
};

/**
 * Inline timeframe (+ board) filter that scopes every section below it. Wires the
 * already-exposed `setTimeframe` / `setSelectedBoard` state — no new state, no
 * backend. The board row only appears for multi-board climbers (the 90% who climb
 * one board never see it). Reuses the native @expo/ui SegmentedControl.
 */
export function ProgressControlBar({
  timeframe,
  onSelectTimeframe,
  selectedBoard,
  onSelectBoard,
  hasActiveFilters,
  onReset,
  layoutPercentages,
}: ProgressControlBarProps) {
  const { t } = useTranslation('profile');
  const { t: tYou } = useTranslation('you');
  const { brandColors } = useTheme();

  const timeframeOptions = useMemo<{ key: UnifiedTimeframeType; label: string }[]>(
    () => [
      { key: 'all', label: tYou('mobile.filter.all') },
      { key: 'lastYear', label: tYou('mobile.filter.year') },
      { key: 'lastMonth', label: tYou('mobile.filter.month') },
      { key: 'lastWeek', label: tYou('mobile.filter.week') },
    ],
    [tYou],
  );

  // Distinct boards the climber actually has, in layout order. Only worth a row
  // when there's more than one board to switch between.
  const boardTypes = useMemo(() => {
    const seen: string[] = [];
    for (const layout of layoutPercentages) {
      if (!seen.includes(layout.boardType)) seen.push(layout.boardType);
    }
    return seen;
  }, [layoutPercentages]);

  const boardOptions = useMemo(
    () => [
      { key: 'all', label: tYou('mobile.filter.allBoards') },
      ...boardTypes.map((boardType) => ({ key: boardType, label: formatBoardDisplayName(boardType) })),
    ],
    [boardTypes, tYou],
  );

  return (
    <View style={styles.container}>
      <SegmentedControl
        options={timeframeOptions}
        selectedKey={timeframe}
        onSelect={onSelectTimeframe}
        accessibilityLabel={tYou('mobile.filter.timeRange')}
      />
      {boardTypes.length > 1 ? (
        <SegmentedControl
          options={boardOptions}
          selectedKey={selectedBoard}
          onSelect={onSelectBoard}
          accessibilityLabel={tYou('mobile.filter.board')}
        />
      ) : null}
      {hasActiveFilters ? (
        <Pressable onPress={onReset} style={styles.resetRow} accessibilityRole="button">
          <Text variant="footnote" color={brandColors.primary}>
            {t('dashboard.reset')}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: spacing[4],
    gap: spacing[2],
  },
  resetRow: {
    alignSelf: 'flex-end',
    paddingVertical: spacing[1],
  },
});
