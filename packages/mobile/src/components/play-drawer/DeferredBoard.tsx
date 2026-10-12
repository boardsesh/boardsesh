import { memo, type ComponentType, type MutableRefObject, type RefObject } from 'react';
import { View, StyleSheet } from 'react-native';
import type { GestureType } from 'react-native-gesture-handler';
import type { BoardName } from '@boardsesh/shared-schema';
import { SwipeBoardCarousel } from './SwipeBoardCarousel';
import type { SwipePager } from './use-swipe-pager';
import { useTheme } from '../../providers/theme-provider';
import type { ReadyBoardArtIdentity, ReadyBoardArtSnapshot } from '../../lib/board-render/ready-board-art';

type BoardRenderData = {
  boardWidth: number;
  boardHeight: number;
};

type DeferredBoardProps = {
  capturePaintedTestID?: string;
  captureLocalMirrorTestID?: string;
  /** Only a closed drawer withholds the interactive board. */
  open: boolean;
  /** Legacy caller hint; artwork mounts independently of measurement readiness. */
  layoutReady?: boolean;
  containerSize?: { width: number; height: number };
  readyBoardArt?: ReadyBoardArtSnapshot;
  onReadyArtDisplayed?: (art: ReadyBoardArtIdentity & { overlayUri: string; overlayLoadKey: string | null }) => void;
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
  /** Shared with the play-drawer header so both swipe as one. See use-swipe-pager. */
  pager: SwipePager;
  centerPage: number;
  /** RNGH ref to the drawer-dismiss Pan, forwarded to the zoomed-only board pan. */
  dismissRef?: MutableRefObject<GestureType | undefined>;
};

/** The persistent current board mounts with the player, before JS layout callbacks. */
export const DeferredBoard = memo(function DeferredBoard({
  open,
  layoutReady: _layoutReady,
  boardRenderData,
  ...carouselProps
}: DeferredBoardProps) {
  const { systemColors } = useTheme();
  if (!open) {
    return (
      <View
        style={[styles.placeholder, { backgroundColor: systemColors.tertiaryFill }]}
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
  },
});
