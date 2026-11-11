import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, Image, StyleSheet, View } from 'react-native';
import {
  BOKEH_DRIFT,
  BOKEH_GLIDE_MS,
  BOKEH_SWELL,
  FROST_ALPHA,
  GRAIN_ALPHA,
  type BokehBlend,
  type BokehBlob,
  type BokehSurface,
} from '@boardsesh/frosted-bokeh';
import grainSource from '@boardsesh/frosted-bokeh/grain.png';
import { NativeFrostedBokehGPU, type GpuBokehBlob } from '../../modules/frosted-bokeh-gpu/src/index';
import { useReduceMotion } from '../hooks/use-reduce-motion';

/** A prepared background. Callers own geometry, palette and contrast policy. */
export type FrostedBokehLayer = {
  key: string;
  blobs: readonly (BokehBlob & { gradient: string })[];
  surface: BokehSurface;
  blend: BokehBlend;
  /** The alpha scale baked into each gradient; the GPU view applies it to `peak` itself. */
  opacityScale?: number;
};

/** Whether this binary can draw the moving frost (iOS builds with the Metal module). */
export const frostedBokehMotionAvailable = NativeFrostedBokehGPU != null;

const CROSS_FADE_MS = 200;

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
            experimental_backgroundImage: blob.gradient,
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
   * Draw the blobs with the Metal shader, breathing and gliding to the next
   * climb, where the binary has it. The caller's label fade must already cover
   * the motion (`motion` in the contrast check).
   */
  moving?: boolean;
};

function FrostedBokehComponent({ layer, beforeFrost, testID = 'frosted-bokeh', moving = false }: FrostedBokehProps) {
  const reduceMotion = useReduceMotion();
  const [gpuFailed, setGpuFailed] = useState(false);
  const handleRenderError = useCallback(() => setGpuFailed(true), []);
  const GpuView = moving && !gpuFailed ? NativeFrostedBokehGPU : null;
  const gpuBlobs = useMemo<GpuBokehBlob[]>(
    () => layer.blobs.map(({ x, y, r, peak, color }) => ({ x, y, r, peak: peak * (layer.opacityScale ?? 1), color })),
    [layer],
  );
  const [previous, setPrevious] = useState<FrostedBokehLayer | null>(null);
  const shownRef = useRef(layer);
  const fadeIn = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const last = shownRef.current;
    shownRef.current = layer;
    // The GPU view glides between climbs itself.
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
      {GpuView ? (
        <GpuView
          style={styles.fill}
          blobs={gpuBlobs}
          base={layer.surface.base}
          blend={layer.blend}
          layerKey={layer.key}
          reduceMotion={reduceMotion}
          drift={BOKEH_DRIFT}
          swell={BOKEH_SWELL}
          glideMs={BOKEH_GLIDE_MS}
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
