// A list with a map card on top: the shape a gym finder takes INSIDE a sheet
// (the add-a-board wizard's "Which gym?", and the Boards-stack copy of the gym
// map), where a second draggable panel under a map would be a sheet on a
// sheet (docs/mobile/mobile-sheets-vs-routes.md, "A map inside a sheet").
//
// One FlashList is the page's one vertical gesture:
//  - its header is the map, an inset card whose frame ends where the rows
//    begin, so Apple's "Maps / Legal" in its bottom-left corner is never
//    covered (expo-maps 58's AppleMaps has no content-inset prop, so the
//    layout is the only fix). The card scrolls away with the rows, and folds
//    to nothing while the screen says so (its search field has focus) or when
//    the map can't draw (the map stays mounted, so a late load can recover).
//  - a sticky slot (a filter capsule row) sits under the card and sticks once
//    the card has scrolled away.
//  - the rows are the caller's, drawn by its `renderItem`.
//  - a footer slot ("Add my gym") is pinned over the bottom of the page above
//    the home indicator. While the keyboard is up it joins the end of the
//    list instead, so it never rides on the keyboard.
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
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
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

/** The map card's height for a page `pageHeight` tall: 30% of it, 150 to 240 pt. */
export function mapCardHeight(pageHeight: number): number {
  return Math.min(MAP_CARD_MAX_HEIGHT, Math.max(MAP_CARD_MIN_HEIGHT, Math.round(pageHeight * MAP_CARD_FRACTION)));
}

export type MapCardListHandle = {
  /** Scroll the row whose key is `key` into view (a pin tap). No-op for an unknown key. */
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
  /** Fold the card away, e.g. while the search field has focus. */
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
  const listRef = useRef<FlashListRef<MapCardListRow<Item>>>(null);

  const hasSticky = stickyHeader !== undefined && stickyHeader !== null;
  const rows = useMemo<MapCardListRow<Item>[]>(() => {
    const items = data.map((item): MapCardListRow<Item> => ({ kind: 'item', item }));
    return hasSticky ? [STICKY_ROW, ...items] : items;
  }, [data, hasSticky]);

  // Read through refs, so the handle never goes stale and never rebuilds.
  const dataRef = useRef(data);
  dataRef.current = data;
  const keyExtractorRef = useRef(keyExtractor);
  keyExtractorRef.current = keyExtractor;
  const hasStickyRef = useRef(hasSticky);
  hasStickyRef.current = hasSticky;
  useImperativeHandle(
    ref,
    () => ({
      scrollToItemKey: (key: string) => {
        const index = dataRef.current.findIndex((item) => keyExtractorRef.current(item) === key);
        if (index < 0) return;
        void listRef.current?.scrollToIndex({
          index: index + (hasStickyRef.current ? 1 : 0),
          animated: true,
          viewPosition: 0.3,
        });
      },
      scrollToTop: () => {
        listRef.current?.scrollToOffset({ offset: 0, animated: true });
      },
    }),
    [],
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

  const cardFolded = mapHidden || !mapAvailable;
  const cardHeight = mapCardHeight(pageHeight);
  const mapCard = useMemo(
    () =>
      map === undefined || map === null ? null : (
        <View
          style={[
            styles.card,
            cardFolded
              ? styles.cardFolded
              : { height: cardHeight, backgroundColor: systemColors.tertiaryFill, marginBottom: spacing[2] },
          ]}
          accessibilityElementsHidden={cardFolded}
          importantForAccessibility={cardFolded ? 'no-hide-descendants' : 'auto'}
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
      ),
    [map, cardFolded, cardHeight, onLocate, locateLabel, systemColors.tertiaryFill, systemColors.secondaryBackground],
  );

  // The pinned footer is measured so the last row can scroll clear of it.
  const [footerHeight, setFooterHeight] = useState(0);
  const onFooterLayout = useCallback((event: LayoutChangeEvent) => {
    const measured = Math.round(event.nativeEvent.layout.height);
    setFooterHeight((previous) => (previous === measured ? previous : measured));
  }, []);
  const footerPinned = footer !== undefined && footer !== null && !keyboardUp;
  const footerAtTail = footer !== undefined && footer !== null && keyboardUp;
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
          ListHeaderComponent={mapCard}
          ListFooterComponent={tailFooter}
          contentContainerStyle={contentStyle}
          // The header block above clears the bar; nothing here is inset by iOS.
          contentInsetAdjustmentBehavior="never"
          // A row tap while the keyboard is up picks the row, not just closes the keyboard.
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
        />
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
  // Wide windows (iPad, a browser) keep the readable 672 pt column.
  column: {
    flex: 1,
    width: '100%',
    maxWidth: READABLE_CONTENT_WIDTH,
    alignSelf: 'center',
  },
  card: {
    ...cardCorners,
    marginHorizontal: spacing[4],
    marginTop: spacing[2],
    overflow: 'hidden',
  },
  // Folded, not unmounted: the map keeps its camera and can report a late load.
  cardFolded: {
    height: 0,
    marginTop: 0,
    marginBottom: 0,
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
