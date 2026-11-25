import { useCallback, useEffect, useRef } from 'react';
import { Platform, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../providers/theme-provider';
import { ChromeIconButton } from '../ChromeIconButton';
import { spacing, shadows } from '../../theme/tokens';
import { GymMap } from './GymMap';
import { GymListPanel, type GymListPanelHandle } from './GymListPanel';
import { panelBoxHeight, useKeyboardOverlap } from './panel-keyboard';
import { useGymFinder } from './use-gym-finder';
import {
  GymFinderClaimSheet,
  GymFinderFilters,
  GymFinderLocationPrompt,
  GymFinderSearch,
  GymFinderStatus,
} from './GymFinderParts';

/**
 * Gym-first board discovery on the root stack (Home's Gyms near you, Gyms you
 * run): a full-screen map with a NON-MODAL draggable gym panel pinned over it.
 * The panel is a plain sibling (no scrim), so the uncovered map above it stays
 * pannable — panning re-queries gyms for the new viewport (debounced, previous
 * results kept so pins/list don't flicker). The search field lives in the panel
 * header: a typed place ("Blackheath NSW") geocodes and relocates the map;
 * otherwise the text filters gyms/boards by name. The list is the primary
 * interaction, so the flow works even where the native map is blank. Selecting
 * a board makes it active.
 *
 * The board picker's copy of this screen is `GymFinderCardScreen`: inside the
 * picker's sheet a second draggable panel would be a sheet on a sheet.
 */
export function GymFinderMapScreen() {
  const { t } = useTranslation('boards');
  const { systemColors, brandColors } = useTheme();
  const insets = useSafeAreaInsets();
  // The panel spans the window; while the keyboard is up it ends at the
  // keyboard's top, so its last rows are never under it (nothing resizes this
  // screen for the keyboard).
  const { height: windowHeight } = useWindowDimensions();
  const keyboardOverlap = useKeyboardOverlap();
  const panelRef = useRef<GymListPanelHandle>(null);
  // A pin tap nudges the panel up from the Low detent so its row is visible.
  const revealRow = useCallback((rowKey: string) => {
    panelRef.current?.ensureVisible();
    panelRef.current?.scrollToRowKey(rowKey);
  }, []);
  const finder = useGymFinder({ revealRow });
  const { mapAvailable } = finder;

  // Once we learn the native map can't render, bias the panel up to its full-list
  // detent — a half-height list over a blank background reads as broken.
  useEffect(() => {
    if (!mapAvailable) panelRef.current?.snapTo('high');
  }, [mapAvailable]);

  // Typing raises the list over the map, so the keyboard doesn't cover the
  // town suggestions or the results.
  const onSearchFocusChange = useCallback((focused: boolean) => {
    if (focused) panelRef.current?.snapTo('high');
  }, []);

  return (
    <View style={[styles.flex, { backgroundColor: systemColors.background }]}>
      {/* The root stack hides headers globally; this screen draws its own
          floating close button over the map. The title is kept for the
          back/breadcrumb affordance. */}
      <Stack.Screen options={{ title: t('mobile.gyms.title') }} />
      {finder.showMap ? (
        <GymMap
          key={finder.mapAttempt}
          ref={finder.mapRef}
          center={finder.center}
          markers={finder.markers}
          onRegionChange={finder.handleRegionChange}
          onMarkerPress={finder.onMarkerPress}
          onMapUnavailable={finder.handleMapUnavailable}
          onMapReady={finder.handleMapReady}
          selectedId={finder.selectedId ?? undefined}
          selectedTint={brandColors.primary}
          style={StyleSheet.absoluteFill}
        />
      ) : null}

      <GymListPanel
        ref={panelRef}
        data={finder.rows}
        mapAvailable={mapAvailable && (Platform.OS !== 'web' || finder.center !== null)}
        availableHeight={panelBoxHeight(windowHeight, keyboardOverlap)}
        onPressGym={finder.onPressGym}
        onActivateBoard={finder.activate}
        onEditGym={finder.onEditGym}
        onEditBoard={finder.onEditBoard}
        onClaimGym={finder.onClaimGym}
        onOpenGym={finder.onOpenGym}
        noBoardsLabel={t('mobile.gyms.noBoards')}
        searchSlot={<GymFinderSearch finder={finder} onFocusChange={onSearchFocusChange} />}
        placeCaption={<GymFinderStatus finder={finder} />}
        filterSlot={finder.filtersShown ? <GymFinderFilters finder={finder} /> : undefined}
        locationPrompt={finder.locationPromptShown ? <GymFinderLocationPrompt location={finder.location} /> : undefined}
      />

      {/* Floating close button over the map (the only chrome left over the
          map). `box-none` on its wrapper lets map pans land in the gaps
          around it. It floats over the map, so it takes an opaque surface and
          a shadow instead of the translucent fill. */}
      <View style={[styles.closeWrap, { paddingTop: insets.top + spacing[2] }]} pointerEvents="box-none">
        <ChromeIconButton
          testID="gyms-close-map"
          icon="close"
          onPress={finder.closeScreen}
          accessibilityLabel={t('mobile.gyms.closeMap')}
          style={[shadows.sm, { backgroundColor: systemColors.secondaryBackground }]}
        />
      </View>

      <GymFinderClaimSheet finder={finder} />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  closeWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: spacing[4],
    alignItems: 'flex-start',
  },
});
