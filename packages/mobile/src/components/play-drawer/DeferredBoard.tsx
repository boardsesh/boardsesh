import { memo } from 'react';
import { View, StyleSheet } from 'react-native';
import type { BoardName } from '@boardsesh/shared-schema';
import { SwipeBoardCarousel } from './SwipeBoardCarousel';
import { iosSystemColors } from '../../theme/ios-colors';
import { useDeferredAfterInteractions } from '../../hooks/use-deferred-after-interactions';

type BoardRenderData = {
  boardWidth: number;
  boardHeight: number;
};

type DeferredBoardProps = {
  /** Drives the InteractionManager gate. While the sheet is presenting this is
   *  false and a sized placeholder stands in for the board; once the present
   *  animation settles it flips true and the interactive carousel mounts. */
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
};

/**
 * Defers mounting the interactive {@link SwipeBoardCarousel} until after the
 * play drawer's present animation settles. The carousel mounts 2×
 * `BoardImageNative` plus a pinch/swipe/zoom gesture composition; rendering all
 * of that synchronously the moment the sheet opens blocks the present animation
 * for ~0.5–1s (the user-reported stall). Mirrors `DeferredSections`'
 * `InteractionManager.runAfterInteractions` approach: the sheet animates open
 * immediately over a board-sized placeholder, then the board mounts a frame
 * later.
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
  // Gate on the open transition only (no resetKey) so the board stays mounted
  // across in-drawer swipes once the drawer is open. The hook defers past the
  // present animation in the common case but falls back to a bounded timeout, so
  // a starved interaction queue can't leave the board permanently unmounted
  // (the "blank board until you reopen" bug).
  const ready = useDeferredAfterInteractions(open);

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
