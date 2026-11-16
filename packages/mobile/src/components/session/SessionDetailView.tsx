import { HorizontalSafeAreaApplied, useHorizontalSafeArea } from '../../hooks/use-horizontal-safe-area';
import { FlashList, type FlashListProps, type FlashListRef } from '@shopify/flash-list';
import type { ReactNode, Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { ActivityIndicator } from '../ActivityIndicator';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { workoutClimbsRowKey, workoutClimbsRowType, type WorkoutClimbsRow } from './workout/workout-climb-rows';
export function SessionDetailView({
  loading,
  found,
  rows,
  renderItem,
  onViewableItemsChanged,
  listRef,
  onLoad,
  header,
  overlays,
  paddingBottom,
}: {
  loading: boolean;
  found: boolean;
  rows: WorkoutClimbsRow[];
  renderItem: FlashListProps<WorkoutClimbsRow>['renderItem'];
  listRef?: Ref<FlashListRef<WorkoutClimbsRow>>;
  onLoad?: FlashListProps<WorkoutClimbsRow>['onLoad'];
  onViewableItemsChanged?: FlashListProps<WorkoutClimbsRow>['onViewableItemsChanged'];
  header?: ReactNode;
  overlays?: ReactNode;
  paddingBottom: number;
}) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const sideInsets = useHorizontalSafeArea();
  if (loading)
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
      </View>
    );
  if (!found)
    return (
      <View style={styles.centered}>
        <Icon name="history" size={48} color={systemColors.tertiaryLabel} />
        <Text variant="headline" color={systemColors.secondaryLabel} style={styles.notFound}>
          {t('mobileDetail.notFound')}
        </Text>
      </View>
    );
  return (
    <View testID="session-detail-screen" style={[styles.flex, { backgroundColor: systemColors.groupedBackground }]}>
      <View style={[styles.flex, { paddingLeft: sideInsets.left, paddingRight: sideInsets.right }]}>
        <HorizontalSafeAreaApplied>
          <FlashList
            ref={listRef}
            onLoad={onLoad}
            data={rows}
            renderItem={renderItem}
            onViewableItemsChanged={onViewableItemsChanged}
            keyExtractor={workoutClimbsRowKey}
            getItemType={workoutClimbsRowType}
            ListHeaderComponent={<>{header}</>}
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={{ paddingBottom }}
          />
        </HorizontalSafeAreaApplied>
      </View>
      {overlays}
    </View>
  );
}
const styles = StyleSheet.create({
  flex: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing[3], paddingHorizontal: spacing[8] },
  notFound: { textAlign: 'center' },
});
