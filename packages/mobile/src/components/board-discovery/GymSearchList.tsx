// A list of gyms from `searchGyms`, one tappable row each. Shared by the gym
// picker sheet in the board builder and the gym-first create flow's "Find your
// gym's board" screen (#8151), so a gym reads the same in both. The host owns
// the search, the location and the states around the list; this draws rows.
//
// The list component is the host's too: a sheet hands in its own
// `BottomSheetFlatList` (the sheet's scroll must own the drag), a screen a
// plain `FlatList`. Both are virtualised: `useNearbyGyms` asks for 50.

import { memo, useCallback, type ComponentType, type ReactElement } from 'react';
import { FlatList, StyleSheet, View, type FlatListProps, type StyleProp, type ViewStyle } from 'react-native';
import type { Gym } from '@boardsesh/shared-schema';
import { useTheme } from '../../providers/theme-provider';
import { hapticLight } from '../../lib/haptics';
import { spacing } from '../../theme/tokens';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { Icon } from '../Icon';

const keyExtractor = (gym: Gym) => gym.uuid;

export const GymRow = memo(function GymRow({
  gym,
  isSelected,
  onSelect,
  showChevron = false,
}: {
  gym: Gym;
  isSelected: boolean;
  onSelect: (gym: Gym) => void;
  /** A row that opens the next screen rather than picking a value. */
  showChevron?: boolean;
}) {
  const { systemColors, brandColors } = useTheme();
  const handlePress = useCallback(() => {
    hapticLight();
    onSelect(gym);
  }, [gym, onSelect]);

  return (
    <PressableSurface
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityState={{ selected: isSelected }}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? systemColors.tertiaryBackground : 'transparent' },
      ]}
    >
      <View style={styles.rowText}>
        <Text variant="body" color={systemColors.label} numberOfLines={1}>
          {gym.name}
        </Text>
        {gym.address ? (
          <Text variant="footnote" color={systemColors.secondaryLabel} numberOfLines={1}>
            {gym.address}
          </Text>
        ) : null}
      </View>
      {isSelected ? <Icon name="check.small" size={20} color={brandColors.primary} /> : null}
      {showChevron && !isSelected ? <Icon name="chevron.right" size={14} color={systemColors.tertiaryLabel} /> : null}
    </PressableSurface>
  );
});

export type GymSearchListProps = {
  gyms: readonly Gym[];
  onSelect: (gym: Gym) => void;
  /** The chosen gym's uuid, drawn with a check. */
  selectedUuid?: string | null;
  /** Rows open the next screen: a chevron instead of a check. */
  showChevrons?: boolean;
  /** A `FlatList`-compatible list. Defaults to `FlatList`; a sheet passes `BottomSheetFlatList`. */
  ListComponent?: ComponentType<FlatListProps<Gym>>;
  ListHeaderComponent?: ReactElement | null;
  ListFooterComponent?: ReactElement | null;
  ListEmptyComponent?: ReactElement | null;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  testID?: string;
};

export function GymSearchList({
  gyms,
  onSelect,
  selectedUuid = null,
  showChevrons = false,
  ListComponent = FlatList as ComponentType<FlatListProps<Gym>>,
  ListHeaderComponent,
  ListFooterComponent,
  ListEmptyComponent,
  style,
  contentContainerStyle,
  testID,
}: GymSearchListProps) {
  const renderItem = useCallback(
    ({ item }: { item: Gym }) => (
      <GymRow gym={item} isSelected={item.uuid === selectedUuid} onSelect={onSelect} showChevron={showChevrons} />
    ),
    [selectedUuid, onSelect, showChevrons],
  );
  return (
    <ListComponent
      testID={testID}
      style={style}
      data={gyms}
      // The search field keeps the keyboard up; without this the first tap on a
      // result only dismissed it and a second tap picked the gym (#5960).
      keyboardShouldPersistTaps="handled"
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      ListHeaderComponent={ListHeaderComponent ?? undefined}
      ListFooterComponent={ListFooterComponent ?? undefined}
      ListEmptyComponent={ListEmptyComponent ?? undefined}
      contentContainerStyle={contentContainerStyle}
      showsVerticalScrollIndicator={false}
    />
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
});
