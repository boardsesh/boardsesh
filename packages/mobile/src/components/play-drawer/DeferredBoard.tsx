import { memo, type ComponentType, type MutableRefObject, type RefObject } from 'react';
import { View, StyleSheet } from 'react-native';
import type { GestureType } from 'react-native-gesture-handler';
import type { SharedValue } from 'react-native-reanimated';
import type { BoardName } from '@boardsesh/shared-schema';
import { SwipeBoardCarousel } from './SwipeBoardCarousel';
import { iosSystemColors } from '../../theme/ios-colors';
import { useDeferredUntilFrame } from '../../hooks/use-deferred-until-frame';

type BoardRenderData = {
  boardWidth: number;
  boardHeight: number;
};

type DeferredBoardProps = {
  /** Drives the single-frame defer gate. While the route commits its first frame
   *  this is false and a sized placeholder stands in for the board; one
   *  requestAnimationFrame later it flips true and the interactive carousel
   *  mounts, so the present animation runs natively over the placeholder. */
  open: boolean;
  boardName: BoardName;
  boardRenderData: BoardRenderData;
  layoutId: number;
  sizeId: number;
  setIds: string;
  currentFrames: string;
  currentFrameOverride?: string | null;
  nextFrames: string | null;
  prevFrames: string | null;
  mirrored: boolean;
  canSwipeNext: boolean;
  canSwipePrevious: boolean;
  onSwipeNext: () => void;
  onSwipePrevious: () => void;
  onResetZoomReady?: (resetZoom: () => void) => void;
  enabled?: boolean;
  scrollRef?: RefObject<ComponentType | undefined | null>;
  swipeTranslateX?: SharedValue<number>;
  swipeIsAnimating?: SharedValue<boolean>;
  /** RNGH ref to the drawer's pull-down-to-dismiss Pan, forwarded to the carousel
   *  so the zoomed board's pan can block it. */
  dismissRef?: MutableRefObject<GestureType | undefined>;
};

/**
 * Defers mounting the interactive {@link SwipeBoardCarousel} until one frame
 * after the play drawer opens. The carousel mounts 2× `BoardImageNative` plus a
 * pinch/swipe/zoom gesture composition; rendering all of that synchronously the
 * moment the route commits blocks the present animation for ~0.5–1s (the
 * user-reported stall). A single `requestAnimationFrame` gate lets the sheet
 * animate open immediately over a board-sized placeholder, then mounts the board
 * a frame later — and unlike `runAfterInteractions` a rAF can't be starved by the
 * sub-sheet hosts churning the interaction queue (the old 350ms-fallback stall,
 * which `docs/mobile-sheets-vs-routes.md` explicitly forbids for this).
 *
 * The gate is keyed on the OPEN TRANSITION (`open`), not on the displayed
 * climb's uuid, so once the drawer is open, swiping to next/prev climbs renders
 * the board immediately with no placeholder flash — the carousel stays mounted
 * across in-drawer swipes.
 *
 * The placeholder fills the board's flex box (`flex: 1`, the same box the
 * contained carousel lays out into) so the first-screen layout is identical
 * whether or not the interactive board has mounted yet — no jump on open.
 */
export const DeferredBoard = memo(function DeferredBoard({
  open,
  boardRenderData,
  ...carouselProps
}: DeferredBoardProps) {
  // Gate on the open transition only so the board stays mounted across in-drawer
  // swipes once the drawer is open. A single rAF fires after the route commits
  // its first frame; it can't be starved the way the interaction queue can, so
  // there's no "blank board until you reopen" fallback to wait out.
  const ready = useDeferredUntilFrame(open);

  if (!ready) {
    return (
      <View
        style={styles.placeholder}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        testID="deferred-board-placeholder"
      />
    );
  }

  return <SwipeBoardCarousel boardRenderData={boardRenderData} {...carouselProps} />;
});

const styles = StyleSheet.create({
  placeholder: {
    flex: 1,
    // Faint board-coloured fill so the present animation lands on a soft skeleton
    // rather than a hard gap. No image decode, no gesture handlers — cheap to
    // mount on the present frame. Matches the section skeleton tint used
    // elsewhere in the play drawer.
    backgroundColor: `${iosSystemColors.systemGray}14`,
  },
});
