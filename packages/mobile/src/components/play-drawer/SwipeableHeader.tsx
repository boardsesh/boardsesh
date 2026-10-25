import { memo, type ReactNode } from 'react';
import { View, StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { pageOffset, type SwipePager } from './use-swipe-pager';

type SwipeableHeaderProps = {
  /** The carousel's pager — the header rides the EXACT same anchor and offset as
   *  the board, so the title/grade slide in lockstep with the climb. */
  pager: SwipePager;
  /** The page the current climb is on; its neighbours are the pages either side. */
  centerPage: number;
  /** The header's own width (screen width). The current header flings past this
   *  and a neighbour slides in by it, so each clears the viewport. */
  viewportWidth: number;
  /** The current climb's header. */
  current: ReactNode;
  /** The neighbours' headers, sliding in edge-adjacent from the side being
   *  swiped towards. Null at a queue boundary. */
  previous: ReactNode;
  next: ReactNode;
  /** What a screen reader reads for the header: one fixed view, never a slot.
   *  Every slot is hidden from assistive tech, because the slots change places
   *  on every climb change and focus on one would be left on a hidden view.
   *  Drawn on top of the slots, so it must let sighted taps through
   *  (`pointerEvents="box-none"`). */
  accessibilityStandIn: ReactNode;
};

type HeaderSlotProps = {
  page: number;
  /** The JS thread shows this climb as current: this header is in flow, sets the
   *  height and takes the sighted taps (copy the name, the setter, the wall pill). */
  isCurrent: boolean;
  anchorPage: SharedValue<number>;
  translateX: SharedValue<number>;
  /** The board's travel for the same swipe; see `pager.slideWidth`. */
  boardSlideWidth: SharedValue<number>;
  viewportWidth: number;
  children: ReactNode;
};

/**
 * One header, keyed by page like the carousel's boards: the neighbour's header
 * becomes the current one by a prop change, never by a remount, and where it
 * sits comes from the pager on the UI thread. Hidden from assistive tech
 * whatever its role; the header's stand-in speaks for it.
 */
const HeaderSlot = memo(function HeaderSlot({
  page,
  isCurrent,
  anchorPage,
  translateX,
  boardSlideWidth,
  viewportWidth,
  children,
}: HeaderSlotProps) {
  const slotStyle = useAnimatedStyle(() => {
    // The offset is in the board's terms: the incoming board is in the middle
    // when it reaches the board's width. The header is as wide as the screen,
    // so its travel is scaled to match and the title arrives with the board.
    // It also keeps the two in step when a swipe takes over a fling, which
    // re-bases the offset by the board's width.
    const boardWidth = boardSlideWidth.value;
    const scale = boardWidth > 0 ? viewportWidth / boardWidth : 1;
    const { visible, offset } = pageOffset(page, anchorPage.value, translateX.value * scale, viewportWidth);
    // Opacity and transform only; see CarouselBoardSlot for why never zIndex.
    return { opacity: visible ? 1 : 0, transform: [{ translateX: offset }] };
  }, [page, viewportWidth]);

  return (
    <Animated.View
      style={[isCurrent ? null : styles.neighbourLayer, slotStyle]}
      pointerEvents={isCurrent ? 'auto' : 'none'}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {children}
    </Animated.View>
  );
});

/**
 * Wraps the play-drawer's title + grade so they swipe with the board. Three
 * headers stay mounted, the current climb's and its two neighbours', on the same
 * pages as the carousel's boards; the pager's anchor says which is in the middle.
 * At rest only that one is drawn. A screen reader reads `accessibilityStandIn`
 * instead: one fixed stand-in like the board's, but on top of the slots rather
 * than under them, because the current header takes sighted taps.
 */
export const SwipeableHeader = memo(function SwipeableHeader({
  pager,
  centerPage,
  viewportWidth,
  current,
  previous,
  next,
  accessibilityStandIn,
}: SwipeableHeaderProps) {
  const renderSlot = (page: number, content: ReactNode, isCurrent: boolean) =>
    content ? (
      <HeaderSlot
        key={page}
        page={page}
        isCurrent={isCurrent}
        anchorPage={pager.anchorPage}
        translateX={pager.translateX}
        boardSlideWidth={pager.slideWidth}
        viewportWidth={viewportWidth}
      >
        {content}
      </HeaderSlot>
    ) : null;

  return (
    <View style={styles.container}>
      {[
        renderSlot(centerPage - 1, previous, false),
        renderSlot(centerPage, current, true),
        renderSlot(centerPage + 1, next, false),
      ]}
      {/* Last, so it is on top: Android's explore-by-touch sends hover events to
          the topmost view first, and the current slot below holds views that
          would take them (the setter link) and announce nothing, being hidden.
          It is `box-none`, so sighted taps still fall through to that slot.
          Always after every slot, so it never changes order against another
          view that stays, and the renderer never takes it out to put it back:
          focus on it outlives the climb change. */}
      {accessibilityStandIn}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    position: 'relative',
  },
  // Pinned over the header slot. The current header stays in normal flow so it
  // defines the header's height.
  neighbourLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
});
