import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { GestureDetector } from 'react-native-gesture-handler';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius, shadows } from '../../theme/tokens';
import { useGymPanelGesture, type GymPanelDetent } from './use-gym-panel-gesture';
import { findRowIndex, type GymListRow } from './gym-list-rows';
import { GymBrowseRow, type GymBrowseRowHandlers } from './GymBrowseRow';

export type GymListPanelHandle = {
  /** Scroll the row carrying this key into view (for a marker tap). */
  scrollToRowKey: (key: string) => void;
  /** Spring to a detent (e.g. nudge Low→Medium when a pin is tapped). */
  snapTo: (detent: GymPanelDetent) => void;
  /** Nudge Low→Medium so a tapped row is visible; never yanks down from Medium/High. */
  ensureVisible: () => void;
};

/** /gyms: tap a gym to expand its boards, tap a board to make it active. */
export type GymListPanelProps = GymBrowseRowHandlers & {
  data: GymListRow[];
  /** Drives the default detent + whether the Low ("reveal the map") detent exists. */
  mapAvailable: boolean;
  /** The pinned search field (lives in the panel header so it survives a blank map). */
  searchSlot: ReactNode;
  /** The "Showing <place>" caption row, when a place is searched. */
  placeCaption?: ReactNode;
  /** Filter chips slot — null until the board-type filter ships. */
  filterSlot?: ReactNode;
  /** Shown in place of the list before a location/place resolves (the search header
   *  stays usable so the user can geocode a place without granting location). */
  locationPrompt?: ReactNode;
  /**
   * The measured height of the box the panel sits in, when it isn't the whole
   * window (above the keyboard while it is up). See `useGymPanelGesture`.
   */
  availableHeight?: number;
};

const keyExtractor = (row: GymListRow) => row.key;
const getItemType = (row: GymListRow) => row.kind;

/**
 * The "Wall Finder" panel: a NON-MODAL inline draggable sheet pinned over the
 * full-screen gym map. It is a plain sibling View — no scrim, no full-screen
 * touch-catcher — so the uncovered map above it stays pannable. A pinned header
 * (handle + search + filter slot) travels with the sheet; the body is one
 * virtualized FlashList. The drag/scroll handoff lives in {@link useGymPanelGesture}.
 *
 * A gym row expands to its boards; a board row makes that board active (the
 * rows are `GymBrowseRow`). Only the root stack's full-screen map draws this
 * panel. Inside the Boards sheet the gym map and the add-a-board gym step are
 * a plain page instead (`MapCardList`): a screen inside a sheet never draws a
 * second draggable panel.
 */
export const GymListPanel = forwardRef<GymListPanelHandle, GymListPanelProps>(function GymListPanel(
  {
    data,
    mapAvailable,
    searchSlot,
    placeCaption,
    filterSlot,
    locationPrompt,
    availableHeight,
    onPressGym,
    onActivateBoard,
    onEditGym,
    onEditBoard,
    onClaimGym,
    onOpenGym,
    noBoardsLabel,
  },
  ref,
) {
  const theme = useTheme();
  const { systemColors } = theme;
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlashListRef<GymListRow>>(null);
  const dataRef = useRef(data);
  dataRef.current = data;

  const {
    gesture,
    nativeGesture,
    panelAnimatedStyle,
    panelHeight,
    scrollEnabled,
    onListScroll,
    onHeaderLayout,
    snapTo,
    ensureVisible,
  } = useGymPanelGesture({ mapAvailable, availableHeight });

  useImperativeHandle(
    ref,
    () => ({
      scrollToRowKey: (key: string) => {
        const index = findRowIndex(dataRef.current, key);
        if (index >= 0) void listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.2 });
      },
      snapTo,
      ensureVisible,
    }),
    [snapTo, ensureVisible],
  );

  const renderItem = useCallback(
    ({ item }: { item: GymListRow }) => (
      <GymBrowseRow
        row={item}
        noBoardsLabel={noBoardsLabel}
        onPressGym={onPressGym}
        onActivateBoard={onActivateBoard}
        onEditGym={onEditGym}
        onEditBoard={onEditBoard}
        onClaimGym={onClaimGym}
        onOpenGym={onOpenGym}
      />
    ),
    [noBoardsLabel, onPressGym, onActivateBoard, onEditGym, onEditBoard, onClaimGym, onOpenGym],
  );

  const listContentStyle = useMemo(
    () => ({ paddingHorizontal: spacing[4], paddingBottom: insets.bottom + spacing[6] }),
    [insets.bottom],
  );

  const cornerStyle = theme.sheet.corners ?? styles.defaultCorners;

  return (
    <Animated.View style={[styles.panel, { height: panelHeight }, panelAnimatedStyle]}>
      <View
        style={[
          styles.surface,
          cornerStyle,
          shadows.lg,
          { backgroundColor: systemColors.secondaryBackground, borderTopColor: systemColors.separator },
        ]}
      >
        <GestureDetector gesture={gesture}>
          <View style={styles.fill}>
            <View style={styles.header} onLayout={onHeaderLayout}>
              <View style={[styles.handle, theme.sheet.handleStyle]} />
              {searchSlot}
              {placeCaption}
              {filterSlot}
            </View>
            {locationPrompt ? (
              <View style={styles.promptArea}>{locationPrompt}</View>
            ) : (
              <GestureDetector gesture={nativeGesture}>
                <FlashList
                  ref={listRef}
                  data={data}
                  renderItem={renderItem}
                  keyExtractor={keyExtractor}
                  getItemType={getItemType}
                  scrollEnabled={scrollEnabled}
                  onScroll={onListScroll}
                  scrollEventThrottle={16}
                  bounces={false}
                  overScrollMode="never"
                  showsVerticalScrollIndicator={false}
                  contentContainerStyle={listContentStyle}
                />
              </GestureDetector>
            )}
          </View>
        </GestureDetector>
      </View>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  panel: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  surface: {
    flex: 1,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  defaultCorners: {
    borderTopLeftRadius: borderRadius.xl,
    borderTopRightRadius: borderRadius.xl,
  },
  fill: {
    flex: 1,
  },
  header: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    gap: spacing[2],
    // Above the list, so the search field's floating town suggestions draw over it.
    zIndex: 1,
  },
  handle: {
    alignSelf: 'center',
    marginBottom: spacing[2],
  },
  promptArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[3],
    padding: spacing[6],
  },
});
