import { memo, type ComponentType, type RefObject } from 'react';
import { View, StyleSheet } from 'react-native';
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
  /** Closing resets the defer gate; reopening starts with a sized placeholder. */
  open: boolean;
  /** The viewport and headers have measured, so the board's flex allocation
   *  no longer depends on the first-screen fallback dimensions. */
  layoutReady: boolean;
  boardName: BoardName;
  boardRenderData: BoardRenderData;
  layoutId: number;
  sizeId: number;
  setIds: string;
  currentFrames: string;
  currentFrameOverride?: string | null;
  nextFrames: string | null;
  prevFrames: string | null;
  /** Frames for the climbs a few swipes ahead; warmed while the renderer is idle. */
  prefetchFrames?: string[];
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
};

/**
 * Defers mounting the interactive {@link SwipeBoardCarousel} until one frame
 * after the open drawer's viewport and headers have measured. The carousel mounts
 * 2× `BoardImageNative` plus a pinch/swipe/zoom gesture composition; rendering all
 * of that synchronously when the route commits blocks the present animation for ~0.5–1s (the
 * user-reported stall). A single `requestAnimationFrame` gate lets the sheet
 * animate open immediately over a board-sized placeholder, then mounts the board
 * a frame later — and unlike `runAfterInteractions` a rAF can't be starved by the
 * sub-sheet hosts churning the interaction queue (the old 350ms-fallback stall,
 * which `docs/mobile-sheets-vs-routes.md` explicitly forbids for this).
 *
 * The gate depends on opening and initial layout readiness, not the displayed
 * climb's uuid or subsequent positive dimensions. Swiping to next/prev climbs
 * renders the board immediately with no placeholder flash — the carousel stays
 * mounted across in-drawer swipes.
 *
 * The placeholder fills the board's flex box (`flex: 1`, the same box the
 * contained carousel lays out into) so the first-screen layout is identical
 * whether or not the interactive board has mounted yet — no jump on open.
 */
export const DeferredBoard = memo(function DeferredBoard({
  open,
  layoutReady,
  boardRenderData,
  ...carouselProps
}: DeferredBoardProps) {
  // Let the viewport and header measurements reach layout before mounting the
  // carousel. Otherwise a cached image can paint at the fallback size and visibly
  // grow mid-presentation. Readiness stays true across swipes and positive resizes.
  const ready = useDeferredUntilFrame(open && layoutReady);

  if (!open || !layoutReady || !ready) {
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
