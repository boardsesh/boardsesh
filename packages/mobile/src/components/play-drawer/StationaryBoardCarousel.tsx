import React, { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import Animated, { runOnUI, useDerivedValue, type AnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { BoardImageNative } from '../BoardImageNative';
import type { BoardArtReadiness } from '../../lib/board-render/ready-board-art';
import type { SwipePager } from './use-swipe-pager';
import { CAROUSEL_LAYER_Z } from './play-drawer-layout';

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
}: Props) {
  const { anchorPage, translateX, slideWidth } = pager;
  const stationaryMotion = pager.stationaryMotion;
  useLayoutEffect(() => {
    if (stationaryMotion) stationaryMotion.value = true;
    return () => {
      if (stationaryMotion) stationaryMotion.value = false;
    };
  }, [stationaryMotion]);
  const pagePosition = useDerivedValue(() => {
    // The header travels beyond one board width while its outgoing tail clears
    // the viewport. Navigation has already advanced the trio at that point;
    // treating the tail as another step briefly reveals the following climb.
    const offset = slideWidth.value > 0 ? -translateX.value / slideWidth.value : 0;
    return anchorPage.value + Math.max(-1, Math.min(1, offset));
  });
  const transition = useMemo(
    () => ({ previousFrames, nextFrames, centerPage, pagePosition, prefetchFrames }),
    [previousFrames, nextFrames, centerPage, pagePosition, prefetchFrames],
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
