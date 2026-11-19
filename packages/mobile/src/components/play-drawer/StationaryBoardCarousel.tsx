import React, { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import Animated, {
  runOnUI,
  useAnimatedReaction,
  useDerivedValue,
  type AnimatedStyle,
  type SharedValue,
} from 'react-native-reanimated';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { BoardImageNative } from '../BoardImageNative';
import type { BoardArtReadiness } from '../../lib/board-render/ready-board-art';
import type { SwipePager } from './use-swipe-pager';
import { CAROUSEL_LAYER_Z } from './play-drawer-layout';
import { climbOverlayGpuApiVersion } from '../../lib/board-render/gpu-native-capability';
import { useWallSwap } from './use-wall-swap';
import { playerRevealMode } from './wall-swap';
import { encodeSwapLook, type BoardSwapFrame } from './swap-look';
import type { BoardRenderDiagnostics, BoardTransition } from './board-transition';
import { usePlayerBoardTransition } from './use-player-board-transition';
import { useStationaryMotionFlag } from './use-stationary-motion-flag';

type Props = {
  boardProps: React.ComponentProps<typeof BoardImageNative>;
  previousFrames: string | null;
  nextFrames: string | null;
  prefetchFrames?: readonly string[];
  centerPage: number;
  pager: SwipePager;
  pageArt: SharedValue<Readonly<Record<number, BoardArtReadiness>>>;
  boardBox: ViewStyle;
  zoomStyle: AnimatedStyle<ViewStyle>;
  onUnavailable: () => void;
  onCurrentArtReadinessChange?: (readiness: BoardArtReadiness) => void;
  /**
   * How the board changes climbs (board-transition.ts). Absent, the player's own:
   * its swap look where the binary draws it, else the shipped wall swap
   * (player-swap-look.ts). The board motion lab passes its own.
   */
  transition?: BoardTransition;
  /** The board motion lab's status line; nothing in production passes one. */
  diagnostics?: BoardRenderDiagnostics;
  /**
   * Gets a copy of each wall-swap frame on the UI thread, for the wall button's
   * frost to follow (option I), and null while this board draws no swap (the
   * wipe) or once it unmounts. Nothing crosses to the JS thread.
   */
  swapFrameMirror?: SharedValue<BoardSwapFrame | null>;
};

/** One photograph and one native compositor; the header still rides the pager.
 * Progress never crosses JS. The native scene prepares all three hold lists
 * before presenting, so one presentation plus the photo makes all three ready.
 */
export const StationaryBoardCarousel = React.memo(function StationaryBoardCarousel({
  boardProps,
  previousFrames,
  nextFrames,
  prefetchFrames,
  centerPage,
  pager,
  pageArt,
  boardBox,
  zoomStyle,
  onUnavailable,
  onCurrentArtReadinessChange,
  transition: requestedTransition,
  diagnostics,
  swapFrameMirror,
}: Props) {
  const { anchorPage, translateX, slideWidth } = pager;
  useStationaryMotionFlag(pager, true);
  const pagePosition = useDerivedValue(() => {
    // One step at most: a drag past the board's width must not reveal the
    // climb after the next one, which the trio may already hold once the JS
    // thread has taken the step.
    const offset = slideWidth.value > 0 ? -translateX.value / slideWidth.value : 0;
    return anchorPage.value + Math.max(-1, Math.min(1, offset));
  });
  // Read even when the lab passes its own, so the hooks never change order.
  const playerTransition = usePlayerBoardTransition();
  const boardTransition = requestedTransition ?? playerTransition;
  // The wall swap keeps its own clock and weights; see wall-swap.ts.
  const revealMode = playerRevealMode(climbOverlayGpuApiVersion, boardTransition?.revealMode);
  const swapFrame = useWallSwap(pager, centerPage, revealMode === 'swap', boardTransition);
  const mirrorsSwap = revealMode === 'swap';
  useAnimatedReaction(
    () => (swapFrameMirror ? (mirrorsSwap ? swapFrame.value : null) : undefined),
    (frame) => {
      if (swapFrameMirror && frame !== undefined) swapFrameMirror.value = frame;
    },
    [swapFrameMirror, mirrorsSwap, swapFrame],
  );
  useLayoutEffect(
    () => () => {
      if (swapFrameMirror) swapFrameMirror.value = null;
    },
    [swapFrameMirror],
  );
  const reduceMotion = boardTransition?.reduceMotion;
  const look = boardTransition?.look;
  const swapLook = useMemo(() => (look ? encodeSwapLook(look) : undefined), [look]);
  const onRenderReady = diagnostics?.onGpuReady;
  const onRenderError = diagnostics?.onGpuError;
  const onSwapLookState = diagnostics?.onSwapLook;
  const transition = useMemo(
    () => ({
      previousFrames,
      nextFrames,
      centerPage,
      pagePosition,
      prefetchFrames,
      revealMode,
      swapFrame,
      swapLook,
      reduceMotion,
      onRenderReady,
      onRenderError,
      onSwapLookState,
    }),
    [
      previousFrames,
      nextFrames,
      centerPage,
      pagePosition,
      prefetchFrames,
      revealMode,
      swapFrame,
      swapLook,
      reduceMotion,
      onRenderReady,
      onRenderError,
      onSwapLookState,
    ],
  );
  const identity = JSON.stringify([
    centerPage,
    boardProps.frames,
    previousFrames,
    nextFrames,
    boardProps.boardName,
    boardProps.layoutId,
    boardProps.sizeId,
    boardProps.setIds,
    boardProps.mirrored,
    boardProps.renderWidth,
    boardProps.fieldColorOverride,
    boardProps.renderStyleOverride,
  ]);
  const readiness = useRef({ identity, generation: 0, art: 'loading' as BoardArtReadiness, gpu: false });
  if (readiness.current.identity !== identity) {
    readiness.current = { identity, generation: readiness.current.generation + 1, art: 'loading', gpu: false };
  }
  // The same three climbs can return after a cancelled/previous navigation.
  // Their old callbacks still belong to the old request, even when IDs match.
  const generation = readiness.current.generation;
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const publishReadiness = useCallback(() => {
    if (!mounted.current || readiness.current.generation !== generation) return;
    const state =
      readiness.current.art === 'failed'
        ? 'failed'
        : readiness.current.art === 'ready' && readiness.current.gpu
          ? 'ready'
          : 'loading';
    onCurrentArtReadinessChange?.(state);
    runOnUI((nextState: BoardArtReadiness) => {
      'worklet';
      pageArt.value = {
        ...pageArt.value,
        [centerPage - 1]: previousFrames === null ? 'ready' : nextState,
        [centerPage]: nextState,
        [centerPage + 1]: nextFrames === null ? 'ready' : nextState,
      };
    })(state);
  }, [generation, centerPage, previousFrames, nextFrames, pageArt, onCurrentArtReadinessChange]);
  useLayoutEffect(() => {
    publishReadiness();
    return () => {
      runOnUI(() => {
        'worklet';
        const remaining = { ...pageArt.value };
        delete remaining[centerPage - 1];
        delete remaining[centerPage];
        delete remaining[centerPage + 1];
        pageArt.value = remaining;
      })();
    };
  }, [centerPage, pageArt, publishReadiness]);
  const handleArtReadiness = useCallback(
    (art: BoardArtReadiness) => {
      if (!mounted.current || readiness.current.generation !== generation) return;
      readiness.current.art = art;
      publishReadiness();
    },
    [generation, publishReadiness],
  );
  const handleGpuState = useCallback(
    (state: 'unavailable' | 'loading' | 'ready') => {
      if (!mounted.current || readiness.current.generation !== generation) return;
      if (state === 'unavailable') {
        onUnavailable();
        return;
      }
      readiness.current.gpu = state === 'ready';
      publishReadiness();
    },
    [generation, onUnavailable, publishReadiness],
  );

  return (
    <View
      style={styles.slot}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Animated.View
        style={[boardBox, zoomStyle]}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <BoardImageNative
          {...boardProps}
          gpuTransition={transition}
          onGpuTransitionStateChange={handleGpuState}
          onArtReadinessChange={handleArtReadiness}
        />
      </Animated.View>
    </View>
  );
});

const styles = StyleSheet.create({
  slot: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: CAROUSEL_LAYER_Z.board,
  },
});
