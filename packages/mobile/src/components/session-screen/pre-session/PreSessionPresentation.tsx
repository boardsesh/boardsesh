import type { ReactNode, Ref } from 'react';
import { StyleSheet, View, type ViewInstance } from 'react-native';
import { FlashList, type FlashListProps, type FlashListRef } from '@shopify/flash-list';
import { ScrollView as GestureScrollView } from 'react-native-gesture-handler';
import type { PreviewListRow } from './workout-preview-sections';
export type PreSessionPresentationProps = {
  screenRef?: Ref<ViewInstance>;
  listRef?: Ref<FlashListRef<PreviewListRow>>;
  rows: PreviewListRow[];
  renderItem: FlashListProps<PreviewListRow>['renderItem'];
  header: ReactNode;
  chrome?: ReactNode;
  footer: ReactNode;
  automaticInsets: boolean;
  paddingTop: number;
  paddingBottom: number;
  indicatorTop: number;
  listProps?: Pick<
    FlashListProps<PreviewListRow>,
    'onScroll' | 'onLayout' | 'onLoad' | 'viewabilityConfig' | 'onContentSizeChange' | 'onViewableItemsChanged'
  >;
};
const keyExtractor = (row: PreviewListRow) => row.key;
const getItemType = (row: PreviewListRow) => row.kind;
/** The Record form and preview share one gesture-aware, virtualized scroll host. */
export function PreSessionPresentation({
  screenRef,
  listRef,
  rows,
  renderItem,
  header,
  chrome,
  footer,
  automaticInsets,
  paddingTop,
  paddingBottom,
  indicatorTop,
  listProps,
}: PreSessionPresentationProps) {
  return (
    <View ref={screenRef} style={styles.fill}>
      <FlashList
        ref={listRef}
        style={styles.fill}
        data={rows}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        getItemType={getItemType}
        ListHeaderComponent={<>{header}</>}
        renderScrollComponent={GestureScrollView}
        contentInsetAdjustmentBehavior={automaticInsets ? 'automatic' : 'never'}
        contentContainerStyle={{ paddingTop, paddingBottom }}
        scrollIndicatorInsets={{ top: indicatorTop }}
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={16}
        {...listProps}
      />
      {chrome}
      {footer}
    </View>
  );
}
const styles = StyleSheet.create({ fill: { flex: 1 } });
