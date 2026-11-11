import { memo, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { BOKEH_GLIDE_MS } from '@boardsesh/frosted-bokeh';
import { FrostedBokeh } from '../FrostedBokeh';
import type { WallGlowLayer } from './use-wall-glow';

/** The button's readable label zone, checked by wallGlowLabelFade. */
const FADE_LEFT = 0.12;
const FADE_WIDTH = 0.76;

type WallGlowProps = {
  layer: WallGlowLayer;
  width: number;
  /** Breathing and gliding on the GPU; the layer's fade must cover the motion. */
  moving?: boolean;
};

/**
 * The label fade while the lights glide to the next climb: the higher of the
 * two climbs' fades until the glide ends, so the in-between frames keep the
 * stronger fade instead of dropping to the new climb's the moment Next lands.
 * It is not a proof for every in-between frame (two lights can pass closer
 * under the label than either climb puts them); the glide lasts 0.7 s and the
 * label also carries its text shadow. Without a glide it is the layer's fade.
 */
export function useGlideHeldFade(key: string, fade: number, gliding: boolean): number {
  const [state, setState] = useState({ key, fade, held: 0 });
  let current = state;
  if (state.key !== key) {
    // React's "adjust state while rendering": the new climb's first frame
    // already carries the held fade.
    current = { key, fade, held: gliding ? Math.max(state.fade, state.held) : 0 };
    setState(current);
  } else if (state.fade !== fade) {
    current = { ...state, fade };
    setState(current);
  }
  const holding = current.held > fade;
  const stale = !holding && current.held > 0;
  useEffect(() => {
    // A fade that rose past the held one ends the hold for good; otherwise a
    // later drop on the same climb would bring an old hold back.
    if (stale) setState((latest) => (latest.key === key ? { ...latest, held: 0 } : latest));
  }, [key, stale]);
  useEffect(() => {
    if (!holding) return undefined;
    const timer = setTimeout(
      () => setState((latest) => (latest.key === key ? { ...latest, held: 0 } : latest)),
      BOKEH_GLIDE_MS,
    );
    return () => clearTimeout(timer);
  }, [key, holding]);
  return holding ? current.held : fade;
}

function WallGlowComponent({ layer, width, moving = false }: WallGlowProps) {
  const { surface } = layer;
  const fade = useGlideHeldFade(layer.key, layer.fade, moving);
  const fullSurfaceFade = layer.readableZone === 'full';
  const fadeGradient =
    fade > 0
      ? `linear-gradient(to right, transparent 0%, ${baseWithAlpha(surface.base, fade)} 10%, ${baseWithAlpha(surface.base, fade)} 90%, transparent 100%)`
      : null;

  return (
    <FrostedBokeh
      layer={layer}
      moving={moving}
      testID="wall-glow"
      beforeFrost={
        fade > 0 && fullSurfaceFade ? (
          <View
            style={[styles.fullFade, { backgroundColor: baseWithAlpha(surface.base, fade) }]}
            testID="wall-glow-label-fade"
          />
        ) : fadeGradient ? (
          <View
            style={[
              styles.fade,
              { left: width * FADE_LEFT, width: width * FADE_WIDTH, experimental_backgroundImage: fadeGradient },
            ]}
            testID="wall-glow-label-fade"
          />
        ) : null
      }
    />
  );
}

function baseWithAlpha(hex: string, alpha: number): string {
  const colorChannels = Number.parseInt(hex.replace('#', '').slice(0, 6), 16);
  return `rgba(${(colorChannels >> 16) & 255}, ${(colorChannels >> 8) & 255}, ${colorChannels & 255}, ${alpha})`;
}

export const WallGlow = memo(WallGlowComponent);

const styles = StyleSheet.create({
  fullFade: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  fade: {
    position: 'absolute',
    top: 0,
    bottom: 0,
  },
});
