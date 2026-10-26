import { memo, type ReactElement } from 'react';
import { StyleSheet } from 'react-native';
import { FlashList, type ListRenderItem } from '@shopify/flash-list';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { spacing } from '../../../theme/tokens';
import type { PreviewListRow } from './workout-preview-sections';

type WorkoutPreviewPaneProps = {
  rows: readonly PreviewListRow[];
  renderRow: ListRenderItem<PreviewListRow>;
  keyExtractor: (row: PreviewListRow) => string;
  getItemType: (row: PreviewListRow) => PreviewListRow['kind'];
  /** `WorkoutPreviewSection`: title, summary and Shuffle, or the state line. */
  header: ReactElement;
};

/**
 * The workout preview on its own, filling the phone split's leading pane (iPhone
 * Duo open in landscape) while a workout is built: the same heading and rows the
 * stacked layout shows under the block cards, from the same `PreSessionView`
 * state, so the two never disagree. Rendered through `usePhoneSplitPaneContent`.
 *
 * The pane's safe area has its sides zeroed; the top and bottom are the tab's,
 * so the last row clears the bottom accessory that spans the split.
 */
export const WorkoutPreviewPane = memo(function WorkoutPreviewPane({
  rows,
  renderRow,
  keyExtractor,
  getItemType,
  header,
}: WorkoutPreviewPaneProps) {
  const insets = useSafeAreaInsets();
  return (
    <FlashList
      testID="workout-preview-pane"
      style={styles.list}
      data={rows}
      renderItem={renderRow}
      keyExtractor={keyExtractor}
      getItemType={getItemType}
      ListHeaderComponent={header}
      contentInsetAdjustmentBehavior="never"
      contentContainerStyle={{ paddingTop: insets.top + spacing[3], paddingBottom: insets.bottom + spacing[4] }}
      showsVerticalScrollIndicator={false}
    />
  );
});

const styles = StyleSheet.create({
  list: { flex: 1 },
});
