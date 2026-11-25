// The gym map's controls, drawn the same in both of its shells (the root map's
// panel header and the board picker's copy above its map card): the search
// field, the board filter chips, the status pill and the location prompt, plus
// the claim sheet an expanded gym row opens. Each reads the shared
// `useGymFinder` state.

import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius } from '../../theme/tokens';
import { ClaimGymSheet } from './ClaimGymSheet';
import { GymLocationPrompt } from './GymLocationPrompt';
import { GymSearchField } from './GymSearchField';
import { WallFinderFilterChips } from './WallFinderFilterChips';
import type { GymFinder } from './use-gym-finder';

/** The search field: a typed place relocates, anything else filters gyms by name. */
export function GymFinderSearch({
  finder,
  onFocusChange,
}: {
  finder: GymFinder;
  onFocusChange?: (focused: boolean) => void;
}) {
  return (
    <GymSearchField
      text={finder.inputText}
      hasSelectedPlace={finder.searchLabel !== null}
      isGeocoding={finder.isGeocoding}
      onChangeText={finder.onChangeSearchText}
      onSubmit={() => void finder.onSubmitSearch()}
      onSelectPlace={finder.onSelectPlace}
      onClear={finder.clearSearch}
      onFocusChange={onFocusChange}
    />
  );
}

/** The board type, layout, size and "2+ board types" chips. */
export function GymFinderFilters({ finder }: { finder: GymFinder }) {
  const { t } = useTranslation('boards');
  const { appliedFilter } = finder;
  return (
    <WallFinderFilterChips
      selected={appliedFilter.boardTypes ?? []}
      onToggle={finder.onToggleBoardType}
      multiBoardTypeOnly={appliedFilter.multiBoardTypeOnly ?? false}
      onToggleMultiBoardType={finder.onToggleMultiBoardType}
      multiBoardLabel={t('mobile.gyms.multiBoardChip')}
      layoutOptions={finder.layoutOptions}
      selectedLayoutIds={appliedFilter.layoutIds ?? []}
      onToggleLayout={finder.onToggleLayout}
      sizeOptions={finder.sizeOptions}
      selectedSizeIds={appliedFilter.sizeIds ?? []}
      onToggleSize={finder.onToggleSize}
      onClear={finder.onClearFilters}
    />
  );
}

/**
 * "Showing <place>", "Updating…", a map that can't draw and a failed refresh,
 * each with its retry. Nothing at all while there is nothing to say.
 * `mapUnavailableShown` false keeps the map's message off where there is never
 * a map (a browser), where saying so would be noise.
 */
export function GymFinderStatus({
  finder,
  mapUnavailableShown = true,
  inset = false,
}: {
  finder: GymFinder;
  mapUnavailableShown?: boolean;
  /** Indent the pill by the page gutter (a list with no padding of its own). */
  inset?: boolean;
}) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const { searchLabel, isUpdating, refreshFailed } = finder;
  const mapUnavailable = !finder.mapAvailable && mapUnavailableShown;
  if (!searchLabel && !isUpdating && !refreshFailed && !mapUnavailable) return null;
  return (
    <View
      style={[styles.placePill, inset ? styles.inset : null, { backgroundColor: systemColors.background }]}
      testID="gym-finder-status"
    >
      {searchLabel ? (
        <Text variant="caption1" color={systemColors.secondaryLabel}>
          {t('mobile.gyms.showingPlace', { place: searchLabel })}
        </Text>
      ) : null}
      {isUpdating ? (
        <Text variant="caption1" color={systemColors.secondaryLabel} accessibilityLiveRegion="polite">
          {t('mobile.gyms.updating')}
        </Text>
      ) : null}
      {mapUnavailable ? (
        <>
          <Text variant="caption1" color={systemColors.secondaryLabel} accessibilityLiveRegion="polite">
            {t('mobile.gyms.mapUnavailable')}
          </Text>
          <PressableSurface onPress={finder.retryMap} accessibilityRole="button" hitSlop={8}>
            <Text variant="caption1" color={systemColors.accent}>
              {t('mobile.gyms.retryMap')}
            </Text>
          </PressableSurface>
        </>
      ) : null}
      {refreshFailed ? (
        <>
          <Text variant="caption1" color={systemColors.secondaryLabel} accessibilityLiveRegion="polite">
            {t('mobile.gyms.refreshFailed')}
          </Text>
          <PressableSurface onPress={finder.retrySearch} accessibilityRole="button" hitSlop={8}>
            <Text variant="caption1" color={systemColors.accent}>
              {t('mobile.gyms.retry')}
            </Text>
          </PressableSurface>
        </>
      ) : null}
    </View>
  );
}

/** No place to show yet: ask for location (a typed place works without it). */
export function GymFinderLocationPrompt({
  location,
}: {
  location: Pick<GymFinder['location'], 'status' | 'permission' | 'permissionChecked' | 'request' | 'requestIfAllowed'>;
}) {
  return (
    <GymLocationPrompt
      status={location.status}
      permission={location.permission}
      permissionChecked={location.permissionChecked}
      onRequest={location.request}
      onRecheck={location.requestIfAllowed}
    />
  );
}

/** The ownership claim an expanded gym row starts, mounted per gym so its form starts clean. */
export function GymFinderClaimSheet({ finder }: { finder: GymFinder }) {
  const { claimTargetGym } = finder;
  if (!claimTargetGym) return null;
  return (
    <ClaimGymSheet
      key={claimTargetGym.uuid}
      sheetRef={finder.claimSheetRef}
      gym={claimTargetGym}
      onClosed={finder.onClaimSheetClosed}
    />
  );
}

const styles = StyleSheet.create({
  placePill: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
    borderRadius: borderRadius.full,
  },
  inset: {
    marginHorizontal: spacing[4],
    marginTop: spacing[1],
  },
});
