import { memo, type ReactNode } from 'react';
import { View, StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { DrawerHeaderPinnedLeading } from '../DrawerHeader';
import type { SwipePager } from './use-swipe-pager';
import { useReduceMotion } from '../../hooks/use-reduce-motion';

/**
 * How far a header drifts while it fades, in points: the outgoing one toward
 * the side it leaves by, the incoming one in from the side it arrives from.
 * Enough to say which way the list moved; small enough that a name, its grade
 * and its stats never travel far from where they rest.
 */
export const HEADER_SWAP_DRIFT = 16;

type SwipeableHeaderProps = {
  /** The carousel's pager — the header rides the EXACT same anchor and offset as
   *  the board, so the climb on the header changes with the climb on the board. */
  pager: SwipePager;
  /** The page the current climb is on; its neighbours are the pages either side. */
  centerPage: number;
  /** The current climb's header. */
  current: ReactNode;
  /** The neighbours' headers, faded in when the swipe goes their way. Null at a
   *  queue boundary. */
  previous: ReactNode;
  next: ReactNode;
  /**
   * The header's leading element (the back chip), drawn once over the slots so
   * it never moves, fades or remounts with the climb. Each slot reserves its
   * width with an invisible copy, so every name is centred the same way.
   */
  leading?: ReactNode;
  /** What a screen reader reads for the header: one fixed view, never a slot.
   *  Every slot is hidden from assistive tech, because the slots change places
   *  on every climb change and focus on one would be left on a hidden view.
   *  Drawn on top of the slots, so it must let sighted taps through
   *  (`pointerEvents="box-none"`). */
  accessibilityStandIn: ReactNode;
};

/**
 * Where a header slot is drawn for the pager's position: one whole block (name,
 * grade, stats), never a name beside another climb's grade.
 *
 * `distance` is how far the page is from the middle, in pages, signed: 0 is at
 * rest, 1 is a whole board width toward the next side. The outgoing header
 * fades out over the first half of the swipe while drifting away; the incoming
 * one fades in over the second half while drifting into place. At most one of
 * them shows at any moment, so a grade is only ever drawn beside its own name.
 */
export function headerSlotFrame(distance: number, drift: number): { opacity: number; offset: number } {
  'worklet';
  const away = Math.min(1, Math.abs(distance) * 2);
  return { opacity: 1 - away, offset: Math.sign(distance) * drift * away };
}

type HeaderSlotProps = {
  page: number;
  /** The JS thread shows this climb as current: this header is in flow, sets the
   *  height and takes the sighted taps (copy the name, the setter). */
  isCurrent: boolean;
  anchorPage: SharedValue<number>;
  translateX: SharedValue<number>;
  /** The board's travel for the same swipe; see `pager.slideWidth`. */
  boardSlideWidth: SharedValue<number>;
  stationaryMotion: SharedValue<boolean>;
  reduceMotion: boolean;
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
  stationaryMotion,
  reduceMotion,
  children,
}: HeaderSlotProps) {
  const slotStyle = useAnimatedStyle(() => {
    // The anchored GPU board does not reveal under Reduce Motion: its holds
    // change when the step lands, so the title does too.
    if (stationaryMotion?.value && reduceMotion) {
      return { opacity: page === anchorPage.value ? 1 : 0, transform: [{ translateX: 0 }] };
    }
    // The offset is in the board's terms: the incoming board is in the middle
    // when it has travelled the board's width. Clamped to one page, so a drag
    // past the board's width never starts on a third climb's header.
    const boardWidth = boardSlideWidth.value;
    const progress = boardWidth > 0 ? Math.max(-1, Math.min(1, translateX.value / boardWidth)) : 0;
    const { opacity, offset } = headerSlotFrame(
      page - anchorPage.value + progress,
      reduceMotion ? 0 : HEADER_SWAP_DRIFT,
    );
    // Opacity and transform only; see CarouselBoardSlot for why never zIndex.
    return { opacity, transform: [{ translateX: offset }] };
  }, [page, reduceMotion]);

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
 * Wraps the play-drawer's title + grade so they change with the board. Three
 * headers stay mounted, the current climb's and its two neighbours', on the same
 * pages as the carousel's boards; the pager's anchor says which is in the middle.
 * At rest only that one is drawn. A screen reader reads `accessibilityStandIn`
 * instead: one fixed stand-in like the board's, but on top of the slots rather
 * than under them, because the current header takes sighted taps.
 */
export const SwipeableHeader = memo(function SwipeableHeader({
  pager,
  centerPage,
  current,
  previous,
  next,
  leading,
  accessibilityStandIn,
}: SwipeableHeaderProps) {
  const reduceMotion = useReduceMotion();
  const renderSlot = (page: number, content: ReactNode, isCurrent: boolean) =>
    content ? (
      <HeaderSlot
        key={page}
        page={page}
        isCurrent={isCurrent}
        anchorPage={pager.anchorPage}
        translateX={pager.translateX}
        boardSlideWidth={pager.slideWidth}
        stationaryMotion={pager.stationaryMotion}
        reduceMotion={reduceMotion}
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
      {/* Above the slots, so the chip takes its own taps; `box-none`, so every
          other tap reaches the current header. Hidden from assistive tech like
          the slots: the stand-in carries the chip's action. */}
      {leading ? (
        <DrawerHeaderPinnedLeading
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          testID="play-drawer-header-leading"
        >
          {leading}
        </DrawerHeaderPinnedLeading>
      ) : null}
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
