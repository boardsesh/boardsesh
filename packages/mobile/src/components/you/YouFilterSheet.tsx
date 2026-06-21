import { type RefObject, useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import type BottomSheet from '@gorhom/bottom-sheet';
import { useTranslation } from 'react-i18next';
import { BOARD_TYPES, type UnifiedTimeframeType } from '@boardsesh/profile-stats';
import { formatBoardDisplayName } from '@boardsesh/board-config';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { ListRow } from '../ListRow';
import { Sheet } from '../Sheet';
import { Button } from '../Button';
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

  const boardOptions = useMemo(() => ['all', ...BOARD_TYPES], []);
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
      snapPoints={['55%']}
      scrollable
      fullWindowOverlay
      footer={<Button title={t('mobile.filter.done')} onPress={() => sheetRef.current?.close()} />}
    >
      <Text variant="title3" style={styles.title}>
        {t('mobile.filter.title')}
      </Text>

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
  title: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
  },
  segment: {
    paddingHorizontal: spacing[4],
  },
});
