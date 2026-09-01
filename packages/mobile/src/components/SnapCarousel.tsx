import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  View,
  StyleSheet,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewStyle,
  type ViewabilityConfig,
} from 'react-native';
import { FlashList, type FlashListProps, type FlashListRef, type ListRenderItem } from '@shopify/flash-list';
import { useReduceMotion } from '../hooks/use-reduce-motion';
import { spacing } from '../theme/tokens';
import { RAIL_CARD_GAP, centeredContentInset } from './board-look/board-look-card-metrics';

/**
 * The gap between two cards in a snapping rail. Exported because a host that
 * wants to pin a rail's height or compute a scroll offset needs the same number
 * the separator uses — never a second literal that can drift from it. Defined in
 * the rail-geometry module, whose peek arithmetic has to agree with it exactly.
 */
export const SNAP_CARD_GAP = RAIL_CARD_GAP;

/**
 * Below this drag-release speed (points per millisecond) the platform starts no
 * momentum scroll, so no momentum-end event follows the release.
 */
const NO_MOMENTUM_VELOCITY = 0.01;

type SnapCarouselProps<TItem> = {
  data: readonly TItem[];
  /** Fixed card width. Sets the snap interval together with `SNAP_CARD_GAP`. */
  cardWidth: number;
  renderItem: ListRenderItem<TItem>;
  keyExtractor: (item: TItem, index: number) => string;
  /**
   * Everything `renderItem` closes over that FlashList cannot see for itself.
   * Forwarded untouched: FlashList recycles rows and will not re-render an
   * unchanged item just because `renderItem` got a new identity.
   */
  extraData?: unknown;
  /**
   * `'start'` (default) snaps each card to the leading edge — the rail shape the
   * settings screens use, where the copy above it is left-aligned too.
   *
   * `'center'` centres the snapped card in the window, for a hero rail whose card
   * is most of the screen. The two are a real difference in meaning, not only in
   * looks: centred, the card under the reader's eye is the one the footer button
   * is talking about.
   */
  align?: 'start' | 'center';
  /** Window width. Required by `align: 'center'` to compute its content inset. */
  windowWidth?: number;
  /**
   * Fires with the index a flick settles on.
   *
   * Only meaningful with `align: 'center'`, and deliberately NOT wired to
   * selection by this component — a host whose selection writes to storage (or to
   * the physical board's LEDs) must not fire one per swipe.
   */
  onSnapToIndex?: (index: number) => void;
  /** Open the rail on this card rather than always on the first one. */
  initialScrollIndex?: number;
  /**
   * Keep this card in the centre.
   *
   * Only meaningful with `align: 'center'`. A card picked by TAP — a neighbour
   * peeking in from the edge — would otherwise become the chosen one while still
   * sitting half off screen, which breaks the promise the centred layout makes:
   * that the card under your eye is the one the footer button is talking about.
   */
  activeIndex?: number;
  /**
   * How far beyond the viewport FlashList prepares rows, in px. Worth capping on
   * a rail of large board renders: each live card holds a multi-megabyte bitmap.
   */
  drawDistance?: number;
  contentStyle?: ViewStyle;
  accessibilityLabel?: string;
  viewabilityConfig?: ViewabilityConfig;
  /**
   * Forwarded untouched, identity included — a list's `onViewableItemsChanged`
   * must not change between renders, so hosts hold theirs in a ref-backed stable
   * callback and this component must never wrap it.
   */
  onViewableItemsChanged?: FlashListProps<TItem>['onViewableItemsChanged'];
};

/**
 * Horizontal, free-scrolling card rail that snaps each card into place — the
 * native equivalent of the web's `scroll-snap-type: x proximity` scroller.
 *
 * This owns the list config (snapping, separators, content insets) so the rails
 * built on it cannot drift apart on it. Everything above the list — the card, its
 * memoization, per-rail extras — stays with the host.
 */
export function SnapCarousel<TItem>({
  data,
  cardWidth,
  renderItem,
  keyExtractor,
  extraData,
  align = 'start',
  windowWidth,
  onSnapToIndex,
  initialScrollIndex,
  activeIndex,
  drawDistance,
  contentStyle,
  accessibilityLabel,
  viewabilityConfig,
  onViewableItemsChanged,
}: SnapCarouselProps<TItem>) {
  const snapInterval = cardWidth + SNAP_CARD_GAP;
  // A primitive, so the scroll handler below does not take the data ARRAY as a
  // dependency and churn its identity on every host re-render.
  const itemCount = data.length;
  const listRef = useRef<FlashListRef<TItem>>(null);
  const reduceMotion = useReduceMotion();

  // Where the rail actually is, so a selection the rail itself produced does not
  // bounce it back to a position it is already at mid-gesture.
  const settledIndexRef = useRef(initialScrollIndex ?? 0);

  // True from the moment a finger goes down until the rail stops, so scroll
  // frames the climber did not cause cannot move the selection.
  const userScrollingRef = useRef(false);

  // Centring is done with a content INSET, not with `snapToAlignment="center"`.
  //
  // With a leading inset of half the leftover width, card `i` sits centred
  // exactly when the scroll offset is `i * interval` — which is what
  // `snapToAlignment="start"` already snaps to. Setting both would apply the
  // centring twice and shove every card off to one side, leaving no peek at all
  // on the trailing edge.
  const centeredInset = align === 'center' && windowWidth ? centeredContentInset(windowWidth, cardWidth) : null;

  /**
   * Which card an offset belongs to, reported only when it CHANGES.
   *
   * The gate is what makes this safe to call on every scroll frame: a host that
   * re-renders a rail of board images per selection must hear about a card once,
   * as it takes the centre, not sixty times while it sits there.
   */
  const settleAt = useCallback(
    (offsetX: number) => {
      if (!onSnapToIndex) return;
      const index = Math.max(0, Math.min(itemCount - 1, Math.round(offsetX / snapInterval)));
      if (index === settledIndexRef.current) return;
      settledIndexRef.current = index;
      onSnapToIndex(index);
    },
    [onSnapToIndex, snapInterval, itemCount],
  );

  /**
   * Live during the swipe, so the card takes its selected treatment the moment it
   * crosses the middle rather than when the rail finally stops.
   *
   * Only while the CLIMBER is scrolling. A programmatic `scrollToIndex` passes
   * over every card between here and its target, and letting those count would
   * strobe the selection — and the button's label — across each one on the way.
   */
  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!userScrollingRef.current) return;
      settleAt(event.nativeEvent.contentOffset.x);
    },
    [settleAt],
  );

  const handleScrollBeginDrag = useCallback(() => {
    userScrollingRef.current = true;
  }, []);

  const handleMomentumEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      userScrollingRef.current = false;
      settleAt(event.nativeEvent.contentOffset.x);
    },
    [settleAt],
  );

  /**
   * A release with no flick behind it starts no momentum scroll, so
   * `onMomentumScrollEnd` never fires — the rail still snaps to the next card,
   * and the selection would stay on the one you left. That is exactly the desync
   * a centred rail exists to prevent: the card under your eye and the look the
   * button applies must not come apart.
   *
   * Rounding the drag-end offset is safe even though the snap animation has not
   * run yet — snapping rounds to the nearest interval too, so both land on the
   * same card.
   *
   * A release WITH momentum deliberately falls through to `handleMomentumEnd`
   * rather than settling here as well. At drag-end a flick is still mid-scroll,
   * so this offset rounds to whichever card it happens to be passing — the
   * selection, and the button naming it, would visibly flip to that card and
   * then to the real one a moment later.
   */
  const handleScrollEndDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const velocityX = event.nativeEvent.velocity?.x ?? 0;
      if (Math.abs(velocityX) > NO_MOMENTUM_VELOCITY) return;
      userScrollingRef.current = false;
      settleAt(event.nativeEvent.contentOffset.x);
    },
    [settleAt],
  );

  useEffect(() => {
    if (activeIndex == null || activeIndex === settledIndexRef.current) return;
    const list = listRef.current;
    // Recorded only once the scroll is actually on its way. Marking it settled
    // first would leave the ref claiming a position the rail never moved to, and
    // the next matching `activeIndex` would then be skipped as a no-op.
    if (!list) return;
    settledIndexRef.current = activeIndex;
    void list.scrollToIndex({ index: activeIndex, animated: !reduceMotion });
  }, [activeIndex, reduceMotion]);

  const contentContainerStyle = useMemo(
    () => [centeredInset != null ? { paddingHorizontal: centeredInset } : styles.content, contentStyle],
    [centeredInset, contentStyle],
  );

  return (
    // No `estimatedItemSize` — FlashList v2 (installed: 2.3.2) removed it in
    // favour of automatic sizing; passing it is a no-op. Cards are fixed-width
    // (`cardWidth`) so layout is stable regardless.
    <FlashList
      ref={listRef}
      data={data}
      horizontal
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      extraData={extraData}
      showsHorizontalScrollIndicator={false}
      // Snap each card into place: card width + the gap between cards.
      snapToInterval={snapInterval}
      // Always 'start': the inset above is what centres a centred rail.
      snapToAlignment="start"
      decelerationRate="fast"
      disableIntervalMomentum
      initialScrollIndex={initialScrollIndex}
      drawDistance={drawDistance}
      onScrollBeginDrag={onSnapToIndex ? handleScrollBeginDrag : undefined}
      onScroll={onSnapToIndex ? handleScroll : undefined}
      // Every frame, because the selection is gated on the card actually
      // changing — the work happens once per card, not once per frame.
      scrollEventThrottle={onSnapToIndex ? 16 : undefined}
      onMomentumScrollEnd={onSnapToIndex ? handleMomentumEnd : undefined}
      onScrollEndDrag={onSnapToIndex ? handleScrollEndDrag : undefined}
      ItemSeparatorComponent={Separator}
      viewabilityConfig={viewabilityConfig}
      onViewableItemsChanged={onViewableItemsChanged}
      accessibilityLabel={accessibilityLabel}
      // A mutually-exclusive picker, so the rail is the group its cards belong to.
      accessibilityRole="radiogroup"
      contentContainerStyle={contentContainerStyle}
    />
  );
}

function Separator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: spacing[4],
  },
  separator: {
    width: SNAP_CARD_GAP,
  },
});
