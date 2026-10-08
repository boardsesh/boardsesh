import { MEDIUM_LARGE_SNAP_POINTS } from '../sheet-snap-points';
import { type RefObject, useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import type { BottomSheet } from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import { BOARD_FILTER_TYPES, type UnifiedTimeframeType } from '@boardsesh/profile-stats';
import { formatBoardDisplayName } from '@boardsesh/board-config';
import { Icon } from '../Icon';
import { ListRow } from '../ListRow';
import { Sheet } from '../Sheet';
import { SheetTopBar } from '../SheetTopBar';
import { SegmentedControl } from '../SegmentedControl';
import { SectionHeader } from '../SectionHeader';
import { spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

type YouFilterSheetProps = {
  sheetRef: RefObject<BottomSheet | null>;
  selectedBoard: string;
  onSelectBoard: (board: string) => void;
  timeframe: UnifiedTimeframeType;
  onSelectTimeframe: (timeframe: UnifiedTimeframeType) => void;
};

/** Board + timeframe filter for the Progress tab. Applies changes live. */
export function YouFilterSheet({
  sheetRef,
  selectedBoard,
  onSelectBoard,
  timeframe,
  onSelectTimeframe,
}: YouFilterSheetProps) {
  const { t } = useTranslation('you');
  const { systemColors, brandColors } = useTheme();

  // BOARD_FILTER_TYPES, not BOARD_TYPES: the wider list is what the You screen
  // FETCHES so no ascent is dropped, this is what the filter OFFERS.
  const boardOptions = useMemo(() => ['all', ...BOARD_FILTER_TYPES], []);
  const timeframeOptions = useMemo<{ key: UnifiedTimeframeType; label: string }[]>(
    () => [
      { key: 'all', label: t('mobile.filter.all') },
      { key: 'lastYear', label: t('mobile.filter.year') },
      { key: 'lastMonth', label: t('mobile.filter.month') },
      { key: 'lastWeek', label: t('mobile.filter.week') },
    ],
    [t],
  );

  return (
    <Sheet
      ref={sheetRef}
      snapPoints={MEDIUM_LARGE_SNAP_POINTS}
      // Android's fixed partial detent leaves empty sheet under the form.
      // Fit its bounded content there; iOS keeps the requested 55% detent.
      androidContentSized
      scrollable
      header={
        // A close, not a trailing Done: the filters apply as they change, so
        // there is nothing to commit.
        <SheetTopBar
          title={t('mobile.filter.title')}
          leading={{ kind: 'close', onPress: () => sheetRef.current?.close() }}
        />
      }
    >
      <SectionHeader title={t('mobile.filter.timeRange')} />
      <View style={styles.segment}>
        <SegmentedControl
          options={timeframeOptions}
          selectedKey={timeframe}
          onSelect={onSelectTimeframe}
          trackColor={systemColors.fill}
          accessibilityLabel={t('mobile.filter.timeRange')}
        />
      </View>

      <SectionHeader title={t('mobile.filter.board')} />
      {boardOptions.map((board, index) => (
        <ListRow
          key={board}
          title={board === 'all' ? t('mobile.filter.allBoards') : formatBoardDisplayName(board)}
          onPress={() => onSelectBoard(board)}
          showSeparator={index < boardOptions.length - 1}
          trailing={
            selectedBoard === board ? <Icon name="check.small" size={18} color={brandColors.primary} /> : undefined
          }
        />
      ))}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  segment: {
    paddingHorizontal: spacing[4],
  },
});
