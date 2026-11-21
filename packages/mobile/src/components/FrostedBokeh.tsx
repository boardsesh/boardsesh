import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Component,
  type FunctionComponent,
  type ReactNode,
} from 'react';
import { Animated, Image, StyleSheet, View } from 'react-native';
import Reanimated, { useAnimatedProps, type SharedValue } from 'react-native-reanimated';
import {
  BOKEH_DRIFT,
  BOKEH_GLIDE_MS,
  BOKEH_SWAP_MS,
  BOKEH_SWAP_OUT_MS,
  BOKEH_SWELL,
  FROST_ALPHA,
  GRAIN_ALPHA,
  bokehSeed,
  type BokehBlend,
  type BokehBlob,
  type BokehSurface,
} from '@boardsesh/frosted-bokeh';
import grainSource from '@boardsesh/frosted-bokeh/grain.png';
import {
  frostedBokehSwapFrameApi,
  NativeFrostedBokehGPU,
  type FrostedBokehGPUNativeProps,
  type GpuBokehBlob,
  type GpuBokehSwapClimbs,
} from '../../modules/frosted-bokeh-gpu/src/index';
import { useReduceMotion } from '../hooks/use-reduce-motion';
import { gradientBackground } from '../lib/gradient-background';
import type { BoardSwapFrame } from './play-drawer/swap-look';
import { INITIAL_FROST_SWAP_FRAME, useFrostSwapFrame } from './use-frost-swap-frame';

/** A prepared background. Callers own geometry, palette and contrast policy. */
export type FrostedBokehLayer = {
  key: string;
  blobs: readonly (BokehBlob & { gradient: string })[];
  surface: BokehSurface;
  blend: BokehBlend;
  /** The alpha scale baked into each gradient; the GPU view applies it to `peak` itself. */
  opacityScale?: number;
};

/** Whether this binary can draw the moving frost (iOS and Android 13+ builds with the native module). */
export const frostedBokehMotionAvailable = NativeFrostedBokehGPU != null;

/** Whether this binary's frost follows the board's swap frames (`swapFrameApi`), not the old index glide. */
export const frostedBokehFollowsSwap = frostedBokehMotionAvailable && frostedBokehSwapFrameApi >= 1;

/**
 * The board's swap, for a frost that follows it: the board's frames (null
 * while it draws none), the page the layer's climb is on and the climbs either
 * side, as layers of the same size. Pass a new value only when the pair
 * changes; the frames never re-render anything.
 */
export type FrostedBokehSwap = {
  frames: SharedValue<BoardSwapFrame | null>;
  centerPage: number;
  previous: FrostedBokehLayer | null;
  next: FrostedBokehLayer | null;
  /** The board's encoded swap look (`encodeSwapLook`); its six-number frames use it. */
  look?: readonly number[];
};

/** What a ref on the animated GPU view receives: the swap command's target. */
type GpuViewInstance = Component<FrostedBokehGPUNativeProps> | FunctionComponent<FrostedBokehGPUNativeProps>;

const AnimatedGpuView =
  frostedBokehFollowsSwap && NativeFrostedBokehGPU ? Reanimated.createAnimatedComponent(NativeFrostedBokehGPU) : null;

/**
 * A layer's blobs as the GPU view takes them: the opacity scale in `peak`, and
 * for a binary that follows the swap, each light's hold id and breathing seed.
 */
function gpuBokehBlobs(layer: FrostedBokehLayer, withIdentity: boolean): GpuBokehBlob[] {
  const scale = layer.opacityScale ?? 1;
  return layer.blobs.map((blob) => {
    const gpuBlob: GpuBokehBlob = { x: blob.x, y: blob.y, r: blob.r, peak: blob.peak * scale, color: blob.color };
    if (!withIdentity) return gpuBlob;
    return { ...gpuBlob, ...(blob.id !== undefined ? { id: blob.id } : {}), seed: bokehSeed(blob) };
  });
}

const CROSS_FADE_MS = 200;

/**
 * Story captures (the store screenshots) draw the GPU frost still: the real
 * shader with no breathing and no glide, so every capture of a climb is the
 * same picture and the screenshot baseline compare stays meaningful. Dev-only:
 * `__DEV__` drops it from store bundles.
 */
export const FROST_STILL_FOR_CAPTURE = __DEV__ && process.env.EXPO_PUBLIC_STORY_MODE === '1';

function BokehBlobs({
  layer,
  opacity,
  testID,
}: {
  layer: FrostedBokehLayer;
  opacity?: Animated.Value;
  testID: string;
}) {
  const blend = layer.blend === 'normal' ? undefined : layer.blend;
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.fill, { mixBlendMode: blend }, opacity ? { opacity } : null]}
      testID={`${testID}-blobs`}
    >
      {layer.blobs.map((blob, index) => (
        <View
          // Blobs are positional: the index is their identity within a layer.
          // oxlint-disable-next-line react/no-array-index-key
          key={index}
          style={{
            position: 'absolute',
            left: blob.x - blob.r,
            top: blob.y - blob.r,
            width: blob.r * 2,
            height: blob.r * 2,
            ...gradientBackground(blob.gradient),
            mixBlendMode: layer.blend === 'normal' ? undefined : 'screen',
          }}
        />
      ))}
    </Animated.View>
  );
}

type FrostedBokehProps = {
  layer: FrostedBokehLayer;
  /** Optional readability scrim, below the frost and grain. */
  beforeFrost?: ReactNode;
  testID?: string;
  /**
   * Draw the blobs with the native GPU shader, breathing and gliding to the next
   * climb, where the binary has it. The caller's label fade must already cover
   * the motion (`motion` in the contrast check).
   */
  moving?: boolean;
  /**
   * Follow the board's swap: the lights take the board's frames as the climber
   * drags, and run the release on their own when no frames come. Only on a
   * binary that follows the swap (`frostedBokehFollowsSwap`); elsewhere the
   * frost changes climbs as before.
   */
  swap?: FrostedBokehSwap;
};

function FrostedBokehComponent({
  layer,
  beforeFrost,
  testID = 'frosted-bokeh',
  moving = false,
  swap,
}: FrostedBokehProps) {
  const reduceMotion = useReduceMotion();
  const [gpuFailed, setGpuFailed] = useState(false);
  const handleRenderError = useCallback(() => setGpuFailed(true), []);
  const GpuView = moving && !gpuFailed ? NativeFrostedBokehGPU : null;
  const SwapGpuView = moving && !gpuFailed ? AnimatedGpuView : null;
  const followsSwap = SwapGpuView !== null;
  const gpuBlobs = useMemo<GpuBokehBlob[]>(() => gpuBokehBlobs(layer, followsSwap), [layer, followsSwap]);
  const swapPrevious = swap?.previous ?? null;
  const swapNext = swap?.next ?? null;
  const swapCenterPage = swap?.centerPage;
  const swapClimbs = useMemo<GpuBokehSwapClimbs | null>(
    () =>
      followsSwap && swapCenterPage !== undefined
        ? {
            centerPage: swapCenterPage,
            // A missing neighbour is left out, never null: a null nested record does not reach the native view.
            ...(swapPrevious
              ? { previous: { key: swapPrevious.key, blobs: gpuBokehBlobs(swapPrevious, true) } }
              : null),
            ...(swapNext ? { next: { key: swapNext.key, blobs: gpuBokehBlobs(swapNext, true) } } : null),
          }
        : null,
    [followsSwap, swapCenterPage, swapPrevious, swapNext],
  );
  const swapFrames = swapClimbs ? swap?.frames : undefined;
  const { target: swapTarget, latest: latestSwapFrame } = useFrostSwapFrame<GpuViewInstance>(swapFrames, followsSwap);
  // The command's copy for mount; the sequence drops it once the command delivered the frame.
  const swapFrameProps = useAnimatedProps(() => ({ swapFrame: latestSwapFrame.value ?? INITIAL_FROST_SWAP_FRAME }));
  const [previous, setPrevious] = useState<FrostedBokehLayer | null>(null);
  const shownRef = useRef(layer);
  const fadeIn = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const last = shownRef.current;
    shownRef.current = layer;
    // The GPU view changes climbs itself.
    if (last.key === layer.key || reduceMotion || GpuView) {
      setPrevious(null);
      fadeIn.setValue(1);
      return undefined;
    }
    setPrevious(last);
    fadeIn.setValue(0);
    const animation = Animated.timing(fadeIn, { toValue: 1, duration: CROSS_FADE_MS, useNativeDriver: true });
    animation.start(({ finished }) => {
      if (finished) setPrevious(null);
    });
    return () => animation.stop();
  }, [layer, reduceMotion, fadeIn, GpuView]);

  return (
    <View
      pointerEvents="none"
      style={[styles.fill, styles.isolate, { backgroundColor: layer.surface.base }]}
      testID={testID}
    >
      {SwapGpuView ? (
        <SwapGpuView
          ref={swapTarget}
          style={styles.fill}
          blobs={gpuBlobs}
          base={layer.surface.base}
          blend={layer.blend}
          layerKey={layer.key}
          reduceMotion={reduceMotion}
          drift={FROST_STILL_FOR_CAPTURE ? 0 : BOKEH_DRIFT}
          swell={FROST_STILL_FOR_CAPTURE ? 0 : BOKEH_SWELL}
          swapClimbs={swapClimbs}
          swapLook={swap?.look ?? null}
          // A still capture draws each climb whole at once: the shortest release there is.
          releaseMs={FROST_STILL_FOR_CAPTURE ? 1 : BOKEH_SWAP_MS}
          releaseOutMs={FROST_STILL_FOR_CAPTURE ? 1 : BOKEH_SWAP_OUT_MS}
          animatedProps={swapFrameProps}
          onRenderError={handleRenderError}
          testID={`${testID}-gpu`}
        />
      ) : GpuView ? (
        <GpuView
          style={styles.fill}
          blobs={gpuBlobs}
          base={layer.surface.base}
          blend={layer.blend}
          layerKey={layer.key}
          reduceMotion={reduceMotion}
          drift={FROST_STILL_FOR_CAPTURE ? 0 : BOKEH_DRIFT}
          swell={FROST_STILL_FOR_CAPTURE ? 0 : BOKEH_SWELL}
          glideMs={FROST_STILL_FOR_CAPTURE ? 0 : BOKEH_GLIDE_MS}
          onRenderError={handleRenderError}
          testID={`${testID}-gpu`}
        />
      ) : (
        <>
          {previous ? <BokehBlobs layer={previous} testID={testID} /> : null}
          <BokehBlobs layer={layer} opacity={previous ? fadeIn : undefined} testID={testID} />
        </>
      )}
      {beforeFrost}
      {layer.surface.frost ? <View style={[styles.fill, styles.frost]} testID={`${testID}-frost`} /> : null}
      <Image source={grainSource} resizeMode="repeat" style={[styles.fill, styles.grain]} />
    </View>
  );
}

export const FrostedBokeh = memo(FrostedBokehComponent);

const styles = StyleSheet.create({
  fill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  isolate: {
    isolation: 'isolate',
  },
  frost: {
    backgroundColor: `rgba(255, 255, 255, ${FROST_ALPHA})`,
  },
  grain: {
    opacity: GRAIN_ALPHA,
    width: '100%',
    height: '100%',
  },
});
