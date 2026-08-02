// Picks the gym a board sits in, so it lands on the map under that gym instead
// of as a lone pin. Before #4166 mobile never set `gymUuid` at all and a board's
// only tie to a place was a free-text location name.
//
// There is deliberately no "create a gym" form here. Choosing "my gym isn't
// listed" hands the typed name to the server, whose auto-gym path applies the
// nearby-name dedup guards before minting. A raw create-gym form in the app
// would bypass those and become a fresh source of duplicate gyms.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import {
  BottomSheetModal,
  BottomSheetView,
  BottomSheetFlatList,
  BottomSheetTextInput,
} from '@expo/ui/community/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { Gym } from '@boardsesh/shared-schema';
import { useNearbyGyms } from '../../lib/graphql/hooks';
import { useDeviceLocation } from '../../lib/use-device-location';
import { useManagedSheet } from '../../providers/sheet-presentation-provider';
import { androidSafeSnapPoints } from '../sheet-snap-points';
import { Text } from '../Text';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { hapticLight } from '../../lib/haptics';
import { spacing, borderRadius } from '../../theme/tokens';
import { iosSystemColors } from '../../theme/ios-colors';

export type PickedGym = {
  uuid: string;
  name: string;
  latitude?: number | null;
  longitude?: number | null;
};

type GymPickerSheetProps = {
  /** Currently selected gym uuid, so the row can render as chosen. */
  selectedUuid: string | null;
  /** Board coordinates when known — the picker centres on these before asking for device location. */
  boardCoords: { latitude: number; longitude: number } | null;
  onSelect: (gym: PickedGym | null) => void;
  /** "My gym isn't listed" — clears the link and sends the user back to the location field. */
  onRequestManualLocation: () => void;
  onDismiss: () => void;
};

const keyExtractor = (gym: Gym) => gym.uuid;

const GymRow = memo(function GymRow({
  gym,
  isSelected,
  onSelect,
}: {
  gym: Gym;
  isSelected: boolean;
  onSelect: (gym: Gym) => void;
}) {
  const { systemColors, brandColors } = useTheme();
  const handlePress = useCallback(() => {
    hapticLight();
    onSelect(gym);
  }, [gym, onSelect]);

  return (
    <Pressable
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
    </Pressable>
  );
});

export function GymPickerSheet({
  selectedUuid,
  boardCoords,
  onSelect,
  onRequestManualLocation,
  onDismiss,
}: GymPickerSheetProps) {
  const { t } = useTranslation('boards');
  const { systemColors, brandColors } = useTheme();
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<BottomSheetModal>(null);

  const snapPoints = useMemo(() => androidSafeSnapPoints(['75%']), []);
  const managed = useManagedSheet({ open: true, sheetRef, onClose: onDismiss });

  const [search, setSearch] = useState('');
  const deviceLocation = useDeviceLocation();

  // Prefer coordinates the board already carries; otherwise ask the device once.
  const coords = boardCoords ?? deviceLocation.coords;
  useEffect(() => {
    if (boardCoords == null) void deviceLocation.request();
  }, [boardCoords, deviceLocation]);

  // With no coordinates the query still runs as a text search, so someone who
  // declined location can find their gym by typing.
  const { data: gymConnection, isLoading } = useNearbyGyms(coords, 50, search);
  // `searchGyms` already orders by distance, so the server's order is the right
  // order — no client-side distance maths.
  const gyms = useMemo(() => gymConnection?.gyms ?? [], [gymConnection?.gyms]);

  const handleSelectGym = useCallback(
    (gym: Gym) => {
      onSelect({ uuid: gym.uuid, name: gym.name, latitude: gym.latitude, longitude: gym.longitude });
    },
    [onSelect],
  );

  const handleSelectNone = useCallback(() => {
    hapticLight();
    onSelect(null);
  }, [onSelect]);

  const renderItem = useCallback(
    ({ item }: { item: Gym }) => (
      <GymRow gym={item} isSelected={item.uuid === selectedUuid} onSelect={handleSelectGym} />
    ),
    [selectedUuid, handleSelectGym],
  );

  const needsLocation = coords == null && search.trim().length === 0;

  return (
    <BottomSheetModal
      ref={sheetRef}
      index={0}
      snapPoints={snapPoints}
      enablePanDownToClose
      onChange={managed.onChange}
      onFullyDismissed={managed.onFullyDismissed}
      handleIndicatorStyle={styles.indicator}
    >
      <BottomSheetView style={styles.header}>
        <Text variant="title3" color={systemColors.label}>
          {t('mobile.gymPicker.title')}
        </Text>
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.centered}>
          {t('mobile.gymPicker.subtitle')}
        </Text>
      </BottomSheetView>

      <BottomSheetView style={styles.searchWrapper}>
        <BottomSheetTextInput
          value={search}
          onChangeText={setSearch}
          placeholder={t('mobile.gymPicker.searchPlaceholder')}
          placeholderTextColor={systemColors.tertiaryLabel}
          accessibilityLabel={t('mobile.gymPicker.searchPlaceholder')}
          autoCorrect={false}
          style={[styles.searchInput, { backgroundColor: systemColors.tertiaryBackground, color: systemColors.label }]}
        />
      </BottomSheetView>

      <Pressable
        onPress={handleSelectNone}
        accessibilityRole="button"
        accessibilityState={{ selected: selectedUuid == null }}
        style={({ pressed }) => [
          styles.row,
          styles.noGymRow,
          { backgroundColor: pressed ? systemColors.tertiaryBackground : 'transparent' },
        ]}
      >
        <View style={styles.rowText}>
          <Text variant="body" color={systemColors.label}>
            {t('mobile.gymPicker.noGym')}
          </Text>
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {t('mobile.gymPicker.noGymHint')}
          </Text>
        </View>
        {selectedUuid == null ? <Icon name="check.small" size={20} color={brandColors.primary} /> : null}
      </Pressable>

      {needsLocation ? (
        <View style={styles.centerState}>
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.centered}>
            {t('mobile.gyms.locationNeeded')}
          </Text>
          <Button
            title={t('mobile.gyms.grantLocation')}
            onPress={() => void deviceLocation.request()}
            variant="tonal"
            size="medium"
          />
        </View>
      ) : isLoading ? (
        <View style={styles.centerState}>
          <ActivityIndicator size="small" color={brandColors.primary} />
        </View>
      ) : gyms.length === 0 ? (
        <View style={styles.centerState}>
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.centered}>
            {t('mobile.gymPicker.empty')}
          </Text>
        </View>
      ) : (
        <BottomSheetFlatList
          data={gyms}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + spacing[4] }]}
          showsVerticalScrollIndicator={false}
        />
      )}

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing[3] }]}>
        <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.centered}>
          {t('mobile.gymPicker.sharedEditHint')}
        </Text>
        <Button title={t('mobile.gymPicker.addNew')} onPress={onRequestManualLocation} variant="text" size="medium" />
      </View>
    </BottomSheetModal>
  );
}

const styles = StyleSheet.create({
  indicator: {
    backgroundColor: iosSystemColors.separator,
    width: 36,
    height: 5,
    borderRadius: 3,
  },
  header: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
    alignItems: 'center',
    gap: 4,
  },
  centered: {
    textAlign: 'center',
  },
  searchWrapper: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
  },
  searchInput: {
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    fontSize: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  noGymRow: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: iosSystemColors.separator,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  centerState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[3],
    paddingVertical: spacing[8],
    paddingHorizontal: spacing[6],
  },
  listContent: {
    paddingTop: spacing[1],
  },
  footer: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: iosSystemColors.separator,
    gap: spacing[1],
  },
});
