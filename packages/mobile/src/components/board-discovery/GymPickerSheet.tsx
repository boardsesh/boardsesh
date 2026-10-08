// Picks the gym a board sits in, so it lands on the map under that gym instead
// of as a lone pin. Before #4166 mobile never set `gymUuid` at all and a board's
// only tie to a place was a free-text location name.
//
// There is deliberately no "create a gym" form here. Choosing "my gym isn't
// listed" hands the typed name to the server, whose auto-gym path applies the
// nearby-name dedup guards before minting. A raw create-gym form in the app
// would bypass those and become a fresh source of duplicate gyms.

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { View, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { BottomSheetFlatList, BottomSheetTextInput } from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import type { Gym } from '@boardsesh/shared-schema';
import { useNearbyGyms } from '../../lib/graphql/hooks';
import { useDeviceLocation } from '../../lib/use-device-location';
import { ModalSheet } from '../ModalSheet';
import { SheetTopBar } from '../SheetTopBar';
import { Text } from '../Text';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { hapticLight } from '../../lib/haptics';
import { spacing, borderRadius } from '../../theme/tokens';
import { MEDIUM_LARGE_SNAP_POINTS } from '../sheet-snap-points';

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
  /**
   * Whether the board shows on the map at all (it is public). "Not at a gym"
   * promised a pin of its own even on a private wall, which never gets one
   * (#5960). Defaults to true.
   */
  showsOnMap?: boolean;
  /** "My gym isn't listed" — clears the link and sends the user back to the location field. */
  onRequestManualLocation: () => void;
  onDismiss: () => void;
};

const SNAP_POINTS = MEDIUM_LARGE_SNAP_POINTS;

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
  showsOnMap = true,
  onRequestManualLocation,
  onDismiss,
}: GymPickerSheetProps) {
  const { t } = useTranslation('boards');
  const { systemColors, brandColors } = useTheme();
  const [search, setSearch] = useState('');
  const deviceLocation = useDeviceLocation();

  // Prefer coordinates the board already carries; otherwise ask the device once.
  const coords = boardCoords ?? deviceLocation.coords;
  // Depend on `request` (a stable useCallback), not the whole hook result — that
  // object is a fresh reference every render, which re-fired this on each one.
  const requestLocation = deviceLocation.request;
  useEffect(() => {
    if (boardCoords == null) void requestLocation();
  }, [boardCoords, requestLocation]);

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

  const handleRequestManualLocation = useCallback(() => {
    hapticLight();
    onRequestManualLocation();
  }, [onRequestManualLocation]);

  // ModalSheet hands the native sheet a single flex child, lifts the search
  // field over the keyboard and pads the body once for the window bottom inset.
  // "My gym isn't listed" is a row beside "Not at a gym", not a top-bar action:
  // it is too long for the bar, and as a row it stays reachable when a search
  // finds nothing.
  return (
    <ModalSheet
      visible
      snapPoints={SNAP_POINTS}
      onClose={onDismiss}
      header={<SheetTopBar title={t('mobile.gymPicker.title')} leading={{ kind: 'close', onPress: onDismiss }} />}
    >
      <View style={styles.intro}>
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.centered}>
          {t('mobile.gymPicker.subtitle')}
        </Text>
      </View>

      <View style={styles.searchWrapper}>
        <BottomSheetTextInput
          value={search}
          onChangeText={setSearch}
          placeholder={t('mobile.gymPicker.searchPlaceholder')}
          placeholderTextColor={systemColors.tertiaryLabel}
          accessibilityLabel={t('mobile.gymPicker.searchPlaceholder')}
          autoCorrect={false}
          style={[styles.searchInput, { backgroundColor: systemColors.tertiaryBackground, color: systemColors.label }]}
        />
        <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.centered}>
          {t('mobile.gymPicker.sharedEditHint')}
        </Text>
      </View>

      <Pressable
        onPress={handleSelectNone}
        accessibilityRole="button"
        accessibilityState={{ selected: selectedUuid == null }}
        style={({ pressed }) => [
          styles.row,
          { backgroundColor: pressed ? systemColors.tertiaryBackground : 'transparent' },
        ]}
      >
        <View style={styles.rowText}>
          <Text variant="body" color={systemColors.label}>
            {t('mobile.gymPicker.noGym')}
          </Text>
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {showsOnMap ? t('mobile.gymPicker.noGymHint') : t('mobile.gymPicker.noGymHintOffMap')}
          </Text>
        </View>
        {selectedUuid == null ? <Icon name="check.small" size={20} color={brandColors.primary} /> : null}
      </Pressable>

      <Pressable
        onPress={handleRequestManualLocation}
        accessibilityRole="button"
        style={({ pressed }) => [
          styles.row,
          styles.lastFixedRow,
          {
            backgroundColor: pressed ? systemColors.tertiaryBackground : 'transparent',
            borderBottomColor: systemColors.separator,
          },
        ]}
      >
        <View style={styles.rowText}>
          <Text variant="body" color={brandColors.primary}>
            {t('mobile.gymPicker.addNew')}
          </Text>
        </View>
        <Icon name="plus" size={20} color={brandColors.primary} />
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
          style={styles.list}
          data={gyms}
          // The search field keeps the keyboard up; without this the first tap
          // on a result only dismissed it and a second tap picked the gym (#5960).
          keyboardShouldPersistTaps="handled"
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        />
      )}
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  intro: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    paddingBottom: spacing[2],
  },
  centered: {
    textAlign: 'center',
  },
  searchWrapper: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
    gap: spacing[2],
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
  lastFixedRow: {
    borderBottomWidth: StyleSheet.hairlineWidth,
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
  list: {
    flex: 1,
  },
  listContent: {
    paddingTop: spacing[1],
    paddingBottom: spacing[4],
  },
});
