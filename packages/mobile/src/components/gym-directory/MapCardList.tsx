// A list with a map card on top: the shape a gym finder takes INSIDE a sheet
// (the add-a-board wizard's "Which gym?", and the Boards-stack copy of the gym
// map), where a second draggable panel under a map would be a sheet on a
// sheet (docs/mobile/mobile-sheets-vs-routes.md, "A map inside a sheet").
//
// One FlashList is the page's one vertical gesture:
//  - the map sits in an inset card at the top, whose frame ends where the rows
//    begin, so Apple's "Maps / Legal" in its bottom-left corner is never
//    covered (expo-maps 58's AppleMaps has no content-inset prop, so the
//    layout is the only fix). The card scrolls away with the rows, and folds
//    to nothing while the screen says so (a search in progress) or when the
//    map can't draw (the map stays mounted, so a late load can recover).
//  - a sticky slot (a filter capsule row) sits under the card and sticks once
//    the card has scrolled away.
//  - the rows are the caller's, drawn by its `renderItem`.
//  - a footer slot ("Add my gym") is pinned over the bottom of the page above
//    the home indicator. While the keyboard is up it joins the end of the
//    list instead, so it never rides on the keyboard.
//
// The card is NOT inside the scroll view. On Android a ScrollView intercepts
// every vertical move and pinch that starts on a child, and Google Maps never
// asks it not to (no requestDisallowInterceptTouchEvent), so a map in a list
// header can only be panned sideways. Instead the list's header is an empty
// spacer of the card's height, and the card floats over it, a sibling drawn
// above the list, moved up with the scroll offset on the UI thread
// (`useScrollOffset`). A touch on the card reaches the map directly; the
// list never sees it. The page clips the card once it has scrolled away.
//
// Neither platform resizes these screens for the keyboard (panel-keyboard.ts),
// so the page ends at the keyboard's top on its own. No grabber, no rounded
// panel top, no shadow: nothing here pretends to be a sheet.

import {
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import { Platform, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedRef, useAnimatedStyle, useScrollOffset } from 'react-native-reanimated';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChromeIconButton } from '../ChromeIconButton';
import { READABLE_CONTENT_WIDTH } from '../ReadableColumn';
import { useTheme } from '../../providers/theme-provider';
import { cardCorners, shadows, spacing } from '../../theme/tokens';
import { useKeyboardOverlap } from './panel-keyboard';

/** The map card's share of the page, and the floor and ceiling it is clamped to (pt). */
const MAP_CARD_FRACTION = 0.3;
const MAP_CARD_MIN_HEIGHT = 150;
const MAP_CARD_MAX_HEIGHT = 240;
/** The card's gap above and below, inside the space the list leaves for it. */
const MAP_CARD_INSET = spacing[2];

/** The map card's height for a page `pageHeight` tall: 30% of it, 150 to 240 pt. */
export function mapCardHeight(pageHeight: number): number {
  return Math.min(MAP_CARD_MAX_HEIGHT, Math.max(MAP_CARD_MIN_HEIGHT, Math.round(pageHeight * MAP_CARD_FRACTION)));
}

/**
 * Where to scroll so a row is fully in view, or null when it already is. The
 * card and the stuck capsule row cover the list's top, the pinned footer its
 * bottom. The scroll is the smallest that clears them, so as much of the map
 * as possible stays on screen (a pin tap should not scroll the map away).
 * Positions are in list content coordinates; `headerHeight` is the card's
 * space at the top (`getFirstItemOffset`).
 */
export function rowScrollTarget({
  rowTop,
  rowHeight,
  scrollOffset,
  windowHeight,
  headerHeight,
  stickyHeight,
  footerHeight,
}: {
  rowTop: number;
  rowHeight: number;
  scrollOffset: number;
  windowHeight: number;
  headerHeight: number;
  stickyHeight: number;
  footerHeight: number;
}): number | null {
  const visibleTop = Math.max(scrollOffset, headerHeight) + stickyHeight;
  const visibleBottom = scrollOffset + windowHeight - footerHeight;
  const rowBottom = rowTop + rowHeight;
  if (rowTop < visibleTop) return Math.max(0, rowTop - stickyHeight);
  if (rowBottom > visibleBottom) return rowBottom - (windowHeight - footerHeight);
  return null;
}

export type MapCardListHandle = {
  /** Bring the row whose key is `key` into view with the least scroll (a pin tap). No-op for an unknown key. */
  scrollToItemKey: (key: string) => void;
  /** Back to the top, map card and all. */
  scrollToTop: () => void;
};

export type MapCardListProps<Item> = {
  /** The rows under the card, in order. Section headers are rows too. */
  data: readonly Item[];
  /** Draws one row. Keep it a `useCallback` whose deps are stable handlers. */
  renderItem: (info: { item: Item }) => ReactElement | null;
  /** A row's stable key. Hoist it (module scope), as for any FlashList. */
  keyExtractor: (item: Item) => string;
  /** A row's recycling type (FlashList `getItemType`). Defaults to one type. */
  getItemType?: (item: Item) => string;
  /** The map, drawn filling the card (`StyleSheet.absoluteFill`). Omit for a list with no card. */
  map?: ReactNode;
  /** False folds the card away while keeping the map mounted, so a late load can bring it back. Default true. */
  mapAvailable?: boolean;
  /** Fold the card away, e.g. while a search is in progress. */
  mapHidden?: boolean;
  /** The locate button in the card's top-right corner; none without it. */
  onLocate?: () => void;
  /** The locate button's accessibility label. */
  locateLabel?: string;
  /** Under the card, stuck to the top once the card has scrolled away (a capsule row). */
  stickyHeader?: ReactNode;
  /** Pinned over the page's bottom edge; at the end of the list while the keyboard is up. */
  footer?: ReactNode;
  ref?: Ref<MapCardListHandle>;
  testID?: string;
};

type MapCardListRow<Item> = { kind: 'sticky' } | { kind: 'item'; item: Item };

const STICKY_ROW = { kind: 'sticky' } as const;
const STICKY_KEY = '__map-card-list-sticky';
const STICKY_HEADER_INDICES = [0];
// The stuck copy of the capsule row is the one on screen: hide the row it
// stands for, so a screen reader doesn't meet the capsules twice.
const STICKY_HEADER_CONFIG = { hideRelatedCell: true };
// Android draws Google Maps on a SurfaceView, which a rounded parent can't
// clip: square the card there rather than show corners the map pokes out of.
const CARD_CORNERS = Platform.OS === 'android' ? null : cardCorners;

export function MapCardList<Item>({
  data,
  renderItem,
  keyExtractor,
  getItemType,
  map,
  mapAvailable = true,
  mapHidden = false,
  onLocate,
  locateLabel,
  stickyHeader,
  footer,
  ref,
  testID,
}: MapCardListProps<Item>) {
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const keyboardOverlap = useKeyboardOverlap();
  const keyboardUp = keyboardOverlap > 0;
  const listRef = useAnimatedRef<FlashListRef<MapCardListRow<Item>>>();
  const scrollOffset = useScrollOffset(listRef);

  const hasSticky = stickyHeader !== undefined && stickyHeader !== null;
  const rows = useMemo<MapCardListRow<Item>[]>(() => {
    const items = data.map((item): MapCardListRow<Item> => ({ kind: 'item', item }));
    return hasSticky ? [STICKY_ROW, ...items] : items;
  }, [data, hasSticky]);

  // The pinned footer is measured so the last row can scroll clear of it.
  const [footerHeight, setFooterHeight] = useState(0);
  const onFooterLayout = useCallback((event: LayoutChangeEvent) => {
    const measured = Math.round(event.nativeEvent.layout.height);
    setFooterHeight((previous) => (previous === measured ? previous : measured));
  }, []);
  const footerPinned = footer !== undefined && footer !== null && !keyboardUp;
  const footerAtTail = footer !== undefined && footer !== null && keyboardUp;

  // Read through refs, so the handle never goes stale and never rebuilds.
  const dataRef = useRef(data);
  dataRef.current = data;
  const keyExtractorRef = useRef(keyExtractor);
  keyExtractorRef.current = keyExtractor;
  const hasStickyRef = useRef(hasSticky);
  hasStickyRef.current = hasSticky;
  const coveredBottomRef = useRef(0);
  coveredBottomRef.current = footerPinned ? footerHeight : 0;
  useImperativeHandle(
    ref,
    () => ({
      scrollToItemKey: (key: string) => {
        const list = listRef.current;
        const itemIndex = dataRef.current.findIndex((item) => keyExtractorRef.current(item) === key);
        if (!list || itemIndex < 0) return;
        const index = itemIndex + (hasStickyRef.current ? 1 : 0);
        const layout = list.getLayout(index);
        if (!layout) {
          void list.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
          return;
        }
        const headerHeight = list.getFirstItemOffset();
        const target = rowScrollTarget({
          rowTop: headerHeight + layout.y,
          rowHeight: layout.height,
          scrollOffset: list.getAbsoluteLastScrollOffset(),
          windowHeight: list.getWindowSize().height,
          headerHeight,
          stickyHeight: hasStickyRef.current ? (list.getLayout(0)?.height ?? 0) : 0,
          footerHeight: coveredBottomRef.current,
        });
        if (target !== null) list.scrollToOffset({ offset: target, animated: true });
      },
      scrollToTop: () => {
        listRef.current?.scrollToOffset({ offset: 0, animated: true });
      },
    }),
    [listRef],
  );

  const rowKey = useCallback(
    (row: MapCardListRow<Item>) => (row.kind === 'sticky' ? STICKY_KEY : keyExtractor(row.item)),
    [keyExtractor],
  );
  const rowType = useCallback(
    (row: MapCardListRow<Item>) => (row.kind === 'sticky' ? STICKY_KEY : (getItemType?.(row.item) ?? 'item')),
    [getItemType],
  );
  const renderRow = useCallback(
    ({ item: row }: { item: MapCardListRow<Item> }) =>
      row.kind === 'sticky' ? (
        <View style={[styles.sticky, { backgroundColor: systemColors.groupedBackground }]}>{stickyHeader}</View>
      ) : (
        renderItem({ item: row.item })
      ),
    [renderItem, stickyHeader, systemColors.groupedBackground],
  );

  // The page's height sizes the card; the keyboard padding sits inside it, so
  // the card keeps its height while the keyboard is up.
  const [pageHeight, setPageHeight] = useState(0);
  const onPageLayout = useCallback((event: LayoutChangeEvent) => {
    const measured = Math.round(event.nativeEvent.layout.height);
    setPageHeight((previous) => (previous === measured ? previous : measured));
  }, []);

  const hasMap = map !== undefined && map !== null;
  const cardFolded = mapHidden || !mapAvailable;
  const cardHeight = mapCardHeight(pageHeight);
  // The space the card takes at the top of the list: nothing once folded.
  const cardBoxHeight = hasMap && !cardFolded ? cardHeight + MAP_CARD_INSET * 2 : 0;

  // The list's header is an empty spacer the card floats over.
  const cardSpacer = useMemo(
    () => (hasMap ? <View style={{ height: cardBoxHeight }} testID="map-card-spacer" /> : null),
    [hasMap, cardBoxHeight],
  );
  // The card follows the rows up, 1:1, on the UI thread; past its own height
  // it is clipped away, so it stops there. A pull past the top (iOS bounce)
  // moves it down with the rows.
  const cardFollowStyle = useAnimatedStyle(() => {
    const offset = scrollOffset.value;
    return { transform: [{ translateY: offset > cardBoxHeight ? -cardBoxHeight : -offset }] };
  }, [cardBoxHeight]);

  const tailFooter = useMemo(
    () => (footerAtTail ? <View style={styles.tailFooter}>{footer}</View> : null),
    [footerAtTail, footer],
  );

  const contentStyle = useMemo(
    () => ({
      paddingBottom: footerPinned ? footerHeight + spacing[4] : keyboardUp ? spacing[4] : insets.bottom + spacing[6],
    }),
    [footerPinned, footerHeight, keyboardUp, insets.bottom],
  );

  return (
    <View
      style={[styles.page, { backgroundColor: systemColors.groupedBackground, paddingBottom: keyboardOverlap }]}
      onLayout={onPageLayout}
      testID={testID}
    >
      <View style={styles.column}>
        <FlashList
          ref={listRef}
          data={rows}
          renderItem={renderRow}
          keyExtractor={rowKey}
          getItemType={rowType}
          stickyHeaderIndices={hasSticky ? STICKY_HEADER_INDICES : undefined}
          stickyHeaderConfig={STICKY_HEADER_CONFIG}
          ListHeaderComponent={cardSpacer}
          ListFooterComponent={tailFooter}
          contentContainerStyle={contentStyle}
          // The header block above clears the bar; nothing here is inset by iOS.
          contentInsetAdjustmentBehavior="never"
          // A row tap while the keyboard is up picks the row, not just closes the keyboard.
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          scrollEventThrottle={16}
          showsVerticalScrollIndicator={false}
        />
        {hasMap ? (
          // Folded, not unmounted: the outer box shrinks to nothing and clips,
          // while the map keeps its full size inside (a 0×0 Google Map may never
          // load), its camera, and a late load's report.
          <Animated.View
            style={[styles.cardBox, { height: cardBoxHeight }, cardFollowStyle]}
            accessibilityElementsHidden={cardFolded}
            importantForAccessibility={cardFolded ? 'no-hide-descendants' : 'auto'}
            testID="map-card-box"
          >
            <View
              style={[styles.card, CARD_CORNERS, { height: cardHeight, backgroundColor: systemColors.tertiaryFill }]}
              testID="map-card"
            >
              {map}
              {onLocate && locateLabel ? (
                <ChromeIconButton
                  icon="location"
                  role="action"
                  onPress={onLocate}
                  accessibilityLabel={locateLabel}
                  style={[styles.locate, shadows.sm, { backgroundColor: systemColors.secondaryBackground }]}
                  testID="map-card-locate"
                />
              ) : null}
            </View>
          </Animated.View>
        ) : null}
        {footerPinned ? (
          <View
            style={[
              styles.pinnedFooter,
              {
                backgroundColor: systemColors.groupedBackground,
                borderTopColor: systemColors.separator,
                paddingBottom: insets.bottom + spacing[2],
              },
            ]}
            onLayout={onFooterLayout}
            testID="map-card-list-footer"
          >
            {footer}
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
  },
  // Wide windows (iPad, a browser) keep the readable 672 pt column. It clips
  // the card once the rows have carried it up past the top.
  column: {
    flex: 1,
    width: '100%',
    maxWidth: READABLE_CONTENT_WIDTH,
    alignSelf: 'center',
    overflow: 'hidden',
  },
  cardBox: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    overflow: 'hidden',
    paddingHorizontal: spacing[4],
    paddingTop: MAP_CARD_INSET,
  },
  card: {
    overflow: 'hidden',
  },
  locate: {
    position: 'absolute',
    top: spacing[2],
    right: spacing[2],
  },
  sticky: {
    paddingBottom: spacing[1],
  },
  tailFooter: {
    paddingTop: spacing[4],
  },
  pinnedFooter: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: spacing[2],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
