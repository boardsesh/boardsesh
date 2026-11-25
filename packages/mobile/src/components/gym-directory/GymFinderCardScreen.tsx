import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useTransparentHeaderInset } from '../../hooks/use-transparent-header-inset';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { READABLE_CONTENT_WIDTH } from '../ReadableColumn';
import { GymMap } from './GymMap';
import { MapCardList, type MapCardListHandle } from './MapCardList';
import { GymBrowseRow } from './GymBrowseRow';
import type { GymListRow } from './gym-list-rows';
import { useGymFinder } from './use-gym-finder';
import {
  GymFinderClaimSheet,
  GymFinderFilters,
  GymFinderLocationPrompt,
  GymFinderSearch,
  GymFinderStatus,
} from './GymFinderParts';

/** The location prompt standing in for the rows while there is nowhere to look. */
type CardRow = GymListRow | { kind: 'locationPrompt'; key: string };

const LOCATION_PROMPT_ROWS: readonly CardRow[] = [{ kind: 'locationPrompt', key: 'location-prompt' }];
const cardRowKey = (row: CardRow) => row.key;
const cardRowType = (row: CardRow) => row.kind;

/**
 * The gym map inside the board picker's sheet (`app/boards/gyms.tsx`, pushed by
 * Near you's Map ›, In range's Search gyms and Manage boards' +). The same
 * search, filters, rows and picks as the root map (`useGymFinder`), laid out as
 * one page: the search field pinned under the bar, then `MapCardList`, the map
 * as an inset card over the rows. No draggable panel: inside a sheet that would
 * be a sheet on a sheet (docs/mobile/mobile-sheets-vs-routes.md).
 *
 * The bar's back chevron is the way out, so there is no floating close. A gym
 * row expands to its boards; a board picked makes it active and leaves the
 * picker, as a pick on the picker itself does. "See gym", the gym editor and
 * the board editor push inside this same stack.
 */
export function GymFinderCardScreen() {
  const { t } = useTranslation('boards');
  const { systemColors, brandColors } = useTheme();
  const headerInset = useTransparentHeaderInset();
  const listRef = useRef<MapCardListHandle>(null);
  const revealRow = useCallback((rowKey: string) => listRef.current?.scrollToItemKey(rowKey), []);
  // A browser has no native map (GymMap reports it unavailable on mount): start
  // folded there, so no empty card flashes before the list.
  const finder = useGymFinder({ revealRow, mapAvailableOnOpen: Platform.OS !== 'web' });
  const { onPressGym, activate, onEditGym, onEditBoard, onClaimGym, onOpenGym } = finder;

  // Focusing the field folds the map card away and goes back to the top, so
  // the keyboard never covers the results. Letting go keeps it folded while
  // anything is typed (a card regrowing under the finger would throw the rows
  // down mid-drag), as the wizard's gym step does; a town picked brings it back.
  const [mapFolded, setMapFolded] = useState(false);
  const inputTextRef = useRef(finder.inputText);
  inputTextRef.current = finder.inputText;
  const searchLabelRef = useRef(finder.searchLabel);
  searchLabelRef.current = finder.searchLabel;
  const onSearchFocusChange = useCallback((focused: boolean) => {
    if (focused) {
      setMapFolded(true);
      listRef.current?.scrollToTop();
      return;
    }
    // Unfold on a blur that left the field empty, or still holding the picked
    // town's own label: submitting that label changes nothing (the town is
    // already applied), so no later pick would bring the card back.
    const typedText = inputTextRef.current.trim();
    const pickedTownLabel = searchLabelRef.current?.trim() ?? null;
    if (typedText.length === 0 || typedText === pickedTownLabel) setMapFolded(false);
  }, []);
  const placePicked = finder.searchLabel !== null;
  useEffect(() => {
    if (placePicked) setMapFolded(false);
  }, [placePicked]);

  const data = finder.locationPromptShown ? LOCATION_PROMPT_ROWS : finder.rows;
  const noBoardsLabel = t('mobile.gyms.noBoards');
  // Rebuilt only when the location state it shows changes, so the row redraws then.
  const { status, permission, permissionChecked, request, requestIfAllowed } = finder.location;
  const locationPrompt = useMemo(
    () => (
      <View style={styles.promptArea}>
        <GymFinderLocationPrompt location={{ status, permission, permissionChecked, request, requestIfAllowed }} />
      </View>
    ),
    [status, permission, permissionChecked, request, requestIfAllowed],
  );

  const renderRow = useCallback(
    ({ item }: { item: CardRow }) =>
      item.kind === 'locationPrompt' ? (
        locationPrompt
      ) : (
        <View style={styles.gutter}>
          <GymBrowseRow
            row={item}
            noBoardsLabel={noBoardsLabel}
            onPressGym={onPressGym}
            onActivateBoard={activate}
            onEditGym={onEditGym}
            onEditBoard={onEditBoard}
            onClaimGym={onClaimGym}
            onOpenGym={onOpenGym}
          />
        </View>
      ),
    [locationPrompt, noBoardsLabel, onPressGym, activate, onEditGym, onEditBoard, onClaimGym, onOpenGym],
  );

  const { showMap, mapAttempt, mapRef, center, markers, selectedId } = finder;
  const { handleRegionChange, onMarkerPress, handleMapUnavailable, handleMapReady } = finder;
  const mapElement = useMemo(
    () =>
      showMap ? (
        <GymMap
          key={mapAttempt}
          ref={mapRef}
          center={center}
          markers={markers}
          onRegionChange={handleRegionChange}
          onMarkerPress={onMarkerPress}
          onMapUnavailable={handleMapUnavailable}
          onMapReady={handleMapReady}
          selectedId={selectedId ?? undefined}
          selectedTint={brandColors.primary}
          style={StyleSheet.absoluteFill}
        />
      ) : undefined,
    [
      showMap,
      mapAttempt,
      mapRef,
      center,
      markers,
      handleRegionChange,
      onMarkerPress,
      handleMapUnavailable,
      handleMapReady,
      selectedId,
      brandColors.primary,
    ],
  );

  // Rebuilt only when what it shows changes: the card list's sticky row redraws with it.
  const { filtersShown, appliedFilter, layoutOptions, sizeOptions, searchLabel, isUpdating, refreshFailed } = finder;
  const { mapAvailable, retryMap, retrySearch } = finder;
  const finderRef = useRef(finder);
  finderRef.current = finder;
  const stickyHeader = useMemo(
    () => (
      <>
        {filtersShown ? (
          <View style={styles.gutter}>
            <GymFinderFilters finder={finderRef.current} />
          </View>
        ) : null}
        {/* A browser never has the map: saying so there would be noise. */}
        <GymFinderStatus finder={finderRef.current} mapUnavailableShown={Platform.OS !== 'web'} inset />
      </>
    ),
    // Every value the two read is listed; the toggles they also read are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      filtersShown,
      appliedFilter,
      layoutOptions,
      sizeOptions,
      searchLabel,
      isUpdating,
      refreshFailed,
      mapAvailable,
      retryMap,
      retrySearch,
    ],
  );

  return (
    <View
      style={[styles.screen, { backgroundColor: systemColors.groupedBackground, paddingTop: headerInset }]}
      testID="gym-finder-card"
    >
      <Stack.Screen options={{ title: t('mobile.gyms.title') }} />
      <View style={styles.headerBlock}>
        <GymFinderSearch finder={finder} onFocusChange={onSearchFocusChange} />
      </View>
      <MapCardList
        ref={listRef}
        data={data}
        renderItem={renderRow}
        keyExtractor={cardRowKey}
        getItemType={cardRowType}
        map={mapElement}
        mapAvailable={mapAvailable}
        mapHidden={mapFolded}
        stickyHeader={stickyHeader}
        testID="gym-finder-card-list"
      />
      <GymFinderClaimSheet finder={finder} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  // Pinned under the bar; wide windows keep the readable column, as the list
  // does. Above the list, so the field's floating town suggestions draw over it.
  headerBlock: {
    width: '100%',
    maxWidth: READABLE_CONTENT_WIDTH,
    alignSelf: 'center',
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    paddingBottom: spacing[2],
    zIndex: 1,
  },
  gutter: {
    paddingHorizontal: spacing[4],
  },
  promptArea: {
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[6],
    paddingTop: spacing[4],
    paddingBottom: spacing[6],
  },
});
