import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Image, StyleSheet, View } from 'react-native';
import { FROST_ALPHA, GRAIN_ALPHA, type BokehBlend, type BokehBlob, type BokehSurface } from '@boardsesh/frosted-bokeh';
import grainSource from '@boardsesh/frosted-bokeh/grain.png';
import { useReduceMotion } from '../hooks/use-reduce-motion';

/** A prepared background. Callers own geometry, palette and contrast policy. */
export type FrostedBokehLayer = {
  key: string;
  blobs: readonly (BokehBlob & { gradient: string })[];
  surface: BokehSurface;
  blend: BokehBlend;
};

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
};

function FrostedBokehComponent({ layer, beforeFrost, testID = 'frosted-bokeh' }: FrostedBokehProps) {
  const reduceMotion = useReduceMotion();
  const [previous, setPrevious] = useState<FrostedBokehLayer | null>(null);
  const shownRef = useRef(layer);
  const fadeIn = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const last = shownRef.current;
    shownRef.current = layer;
    if (last.key === layer.key || reduceMotion) {
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
  }, [layer, reduceMotion, fadeIn]);

  return (
    <View
      pointerEvents="none"
      style={[styles.fill, styles.isolate, { backgroundColor: layer.surface.base }]}
      testID={testID}
    >
      {previous ? <BokehBlobs layer={previous} testID={testID} /> : null}
      <BokehBlobs layer={layer} opacity={previous ? fadeIn : undefined} testID={testID} />
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
