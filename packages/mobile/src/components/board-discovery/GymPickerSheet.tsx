import { AccessibleBottomSheetTextInput as BottomSheetTextInput } from '../AccessibleBottomSheetTextInput';
import { useTypographyStyles, type TypographyScale } from '../../hooks/use-typography-styles';
import { PressableSurface } from '../PressableSurface';
// Picks the gym a board sits in, so it lands on the map under that gym instead
// of as a lone pin. Before #4166 mobile never set `gymUuid` at all and a board's
// only tie to a place was a free-text location name.
//
// There is deliberately no "create a gym" form here. Choosing "my gym isn't
// listed" hands the typed name to the server, whose auto-gym path applies the
// nearby-name dedup guards before minting. A raw create-gym form in the app
// would bypass those and become a fresh source of duplicate gyms.

import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react';
import { View, ActivityIndicator, StyleSheet, type FlatListProps } from 'react-native';
import { BottomSheetFlatList } from '@expo/ui/community/bottom-sheet';
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
import { canOpenAppSettings, openAppSettings } from '../../lib/open-app-settings';
import { spacing, borderRadius } from '../../theme/tokens';
import { GymSearchList } from './GymSearchList';
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

// The sheet's own list, so the sheet's scroll owns the drag.
const SheetGymList = BottomSheetFlatList as unknown as ComponentType<FlatListProps<Gym>>;

export function GymPickerSheet({
  selectedUuid,
  boardCoords,
  onSelect,
  showsOnMap = true,
  onRequestManualLocation,
  onDismiss,
}: GymPickerSheetProps) {
  const styles = useTypographyStyles(createStyles);
  const { t } = useTranslation('boards');
  const { systemColors, brandColors } = useTheme();
  const [search, setSearch] = useState('');
  // Re-asks after a denial: Use my location is the way back in.
  const deviceLocation = useDeviceLocation({ retryAfterDenial: true });

  // Prefer coordinates the board already carries; otherwise use the device's,
  // but only if the climber already allowed location: opening the sheet never
  // shows the system prompt, Use my location does.
  const coords = boardCoords ?? deviceLocation.coords;
  // Depend on `requestIfAllowed` (a stable useCallback), not the whole hook
  // result — that object is a fresh reference every render.
  const requestLocationIfAllowed = deviceLocation.requestIfAllowed;
  useEffect(() => {
    if (boardCoords == null) void requestLocationIfAllowed();
  }, [boardCoords, requestLocationIfAllowed]);
  // Once only Settings can turn location on, the prompt would be a dead tap.
  const locationSettingsOnly = deviceLocation.permission === 'blocked' && canOpenAppSettings();

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

      <PressableSurface
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
      </PressableSurface>

      <PressableSurface
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
          <Text variant="body" color={systemColors.accent}>
            {t('mobile.gymPicker.addNew')}
          </Text>
        </View>
        <Icon name="plus" size={20} color={systemColors.accent} />
      </PressableSurface>

      {needsLocation ? (
        <View style={styles.centerState}>
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.centered}>
            {t('mobile.gyms.locationNeeded')}
          </Text>
          <Button
            title={t('mobile.gyms.grantLocation')}
            onPress={() => void (locationSettingsOnly ? openAppSettings() : deviceLocation.request())}
            variant="tonal"
            size="medium"
          />
        </View>
      ) : isLoading ? (
        <View style={styles.centerState}>
          <ActivityIndicator size="small" color={systemColors.accent} />
        </View>
      ) : gyms.length === 0 ? (
        <View style={styles.centerState}>
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.centered}>
            {t('mobile.gymPicker.empty')}
          </Text>
        </View>
      ) : (
        <GymSearchList
          ListComponent={SheetGymList}
          style={styles.list}
          gyms={gyms}
          selectedUuid={selectedUuid}
          onSelect={handleSelectGym}
          contentContainerStyle={styles.listContent}
        />
      )}
    </ModalSheet>
  );
}

const createStyles = (textStyles: TypographyScale) =>
  StyleSheet.create({
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
      fontSize: textStyles.callout.fontSize,
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
