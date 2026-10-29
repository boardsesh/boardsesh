import { memo, useEffect, useRef, useState } from 'react';
import { Animated, Image, StyleSheet, View } from 'react-native';
import { useReduceMotion } from '../../hooks/use-reduce-motion';
import { FROST_ALPHA, GRAIN_ALPHA } from './wall-glow';
import type { WallGlowLayer } from './use-wall-glow';

// The lit wall button's fill (#7000, look F1b): the climb's lit holds as soft
// blobs of their role colours, screened together inside an isolated pill on a
// near-black base, under an 8% frost and a still grain, with the label's zone
// faded just enough for 4.5:1. Drawn from a `WallGlowLayer`, which
// `use-wall-glow.ts` builds once per climb, frame, colour set and size: no
// per-frame work here.
//
// When the climb or the playback frame changes, the new glow cross-fades in
// over 200 ms; with Reduce Motion on it swaps at once.

const GRAIN_SOURCE = require('../../../assets/wall-glow/grain.png');
const CROSS_FADE_MS = 200;
/** Where the label fade reaches full strength: the middle 60% of the pill, as `wall-glow.ts` checks it. */
const FADE_LEFT = 0.12;
const FADE_WIDTH = 0.76;

function GlowBlobs({ layer, opacity }: { layer: WallGlowLayer; opacity?: Animated.Value }) {
  // The blobs screen into each other inside the group; the group blends onto
  // the base (screen in dark, multiply in light, normal on old Android).
  const blend = layer.blend === 'normal' ? undefined : layer.blend;
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.fill, { mixBlendMode: blend }, opacity ? { opacity } : null]}
      testID="wall-glow-blobs"
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

type WallGlowProps = {
  layer: WallGlowLayer;
  width: number;
};

function WallGlowComponent({ layer, width }: WallGlowProps) {
  const reduceMotion = useReduceMotion();
  const [previous, setPrevious] = useState<WallGlowLayer | null>(null);
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

  const { surface, fade } = layer;
  const fadeGradient =
    fade > 0
      ? `linear-gradient(to right, transparent 0%, ${baseWithAlpha(surface.base, fade)} 10%, ${baseWithAlpha(surface.base, fade)} 90%, transparent 100%)`
      : null;

  return (
    <View
      pointerEvents="none"
      style={[styles.fill, styles.isolate, { backgroundColor: surface.base }]}
      testID="wall-glow"
    >
      {previous ? <GlowBlobs layer={previous} /> : null}
      <GlowBlobs layer={layer} opacity={previous ? fadeIn : undefined} />
      {fadeGradient ? (
        <View
          style={[
            styles.fade,
            { left: width * FADE_LEFT, width: width * FADE_WIDTH, experimental_backgroundImage: fadeGradient },
          ]}
          testID="wall-glow-label-fade"
        />
      ) : null}
      {surface.frost ? <View style={[styles.fill, styles.frost]} testID="wall-glow-frost" /> : null}
      <Image source={GRAIN_SOURCE} resizeMode="repeat" style={[styles.fill, styles.grain]} />
    </View>
  );
}

function baseWithAlpha(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.replace('#', '').slice(0, 6), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

export const WallGlow = memo(WallGlowComponent);

const styles = StyleSheet.create({
  fill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  // The blobs blend with the pill's base and nothing behind the button.
  isolate: {
    isolation: 'isolate',
  },
  fade: {
    position: 'absolute',
    top: 0,
    bottom: 0,
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
