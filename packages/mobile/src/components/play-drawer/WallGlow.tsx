import { memo, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Reanimated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { BOKEH_GLIDE_MS, BOKEH_SWAP_MS } from '@boardsesh/frosted-bokeh';
import { FrostedBokeh, frostedBokehFollowsSwap, type FrostedBokehSwap } from '../FrostedBokeh';
import type { WallGlowLayer } from './use-wall-glow';
import type { BoardSwapFrame } from './swap-look';
import { swapLabelFade, type SwapLabelFades } from './wall-glow-swap-fade';
import { gradientBackground } from '../../lib/gradient-background';

/** The button's readable label zone, checked by wallGlowLabelFade. */
const FADE_LEFT = 0.12;
const FADE_WIDTH = 0.76;

/** The board's swap, with the neighbours drawn at this pill's size (`FrostedBokehSwap`). */
export type WallGlowSwap = Omit<FrostedBokehSwap, 'previous' | 'next'> & {
  previous: WallGlowLayer | null;
  next: WallGlowLayer | null;
};

type WallGlowProps = {
  layer: WallGlowLayer;
  width: number;
  /** Breathing and changing climbs on the GPU; the layer's fade must cover the motion. */
  moving?: boolean;
  /** Follow the board's swap frames, where the binary can (`frostedBokehFollowsSwap`). */
  swap?: WallGlowSwap;
};

/**
 * The label fade while the lights change climbs: the higher of the two climbs'
 * fades for `holdMs` after the climb changes, so the in-between frames keep the
 * stronger fade instead of dropping to the new climb's the moment Next lands.
 * It is not a proof for every in-between frame (two lights can pass closer
 * under the label than either climb puts them); the change lasts well under a
 * second and the label also carries its text shadow. Without motion it is the
 * layer's fade.
 */
export function useGlideHeldFade(key: string, fade: number, gliding: boolean, holdMs = BOKEH_GLIDE_MS): number {
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
      holdMs,
    );
    return () => clearTimeout(timer);
  }, [key, holding, holdMs]);
  return holding ? current.held : fade;
}

/**
 * The label fade drawn at the strongest fade the swap can need, and dimmed to
 * what each board frame needs on the UI thread (`swapLabelFade`): an opacity
 * of a single layer multiplies its colours' alpha, so the drawn fade is
 * exactly the frame's. Nothing crosses to the JS thread per frame.
 */
function SwapLabelFade({
  frames,
  fades,
  held,
  strongest,
  style,
}: {
  frames: SharedValue<BoardSwapFrame | null>;
  fades: SwapLabelFades;
  held: number;
  strongest: number;
  style: StyleProp<ViewStyle>;
}) {
  const opacity = useAnimatedStyle(() => {
    const needed = Math.max(held, swapLabelFade(frames.value, fades));
    return { opacity: strongest > 0 ? Math.min(1, needed / strongest) : 0 };
  });
  return <Reanimated.View pointerEvents="none" style={[style, opacity]} testID="wall-glow-label-fade" />;
}

function WallGlowComponent({ layer, width, moving = false, swap }: WallGlowProps) {
  const { surface } = layer;
  const followsSwap = moving && frostedBokehFollowsSwap;
  const heldFade = useGlideHeldFade(layer.key, layer.fade, moving, followsSwap ? BOKEH_SWAP_MS : BOKEH_GLIDE_MS);
  const swapFollowed = followsSwap ? swap : undefined;
  const previousFade = swapFollowed?.previous?.fade ?? null;
  const nextFade = swapFollowed?.next?.fade ?? null;
  const centerPage = swapFollowed?.centerPage ?? 0;
  const swapFades = useMemo<SwapLabelFades>(
    () => ({ centerPage, previous: previousFade, current: layer.fade, next: nextFade }),
    [centerPage, previousFade, layer.fade, nextFade],
  );
  // With the swap the view is drawn at the strongest fade any frame can ask for.
  const fade = swapFollowed ? Math.max(heldFade, layer.fade, previousFade ?? 0, nextFade ?? 0) : heldFade;
  // While the board can show a pair, the stricter zone of the two: a neighbour
  // whose label spans the pill needs the full-surface fade too.
  const fullSurfaceFade =
    layer.readableZone === 'full' ||
    swapFollowed?.previous?.readableZone === 'full' ||
    swapFollowed?.next?.readableZone === 'full';
  const fadeGradient =
    fade > 0
      ? `linear-gradient(to right, transparent 0%, ${baseWithAlpha(surface.base, fade)} 10%, ${baseWithAlpha(surface.base, fade)} 90%, transparent 100%)`
      : null;
  const fadeStyle: StyleProp<ViewStyle> | null =
    fade > 0 && fullSurfaceFade
      ? [styles.fullFade, { backgroundColor: baseWithAlpha(surface.base, fade) }]
      : fadeGradient
        ? [styles.fade, { left: width * FADE_LEFT, width: width * FADE_WIDTH, ...gradientBackground(fadeGradient) }]
        : null;

  return (
    <FrostedBokeh
      layer={layer}
      moving={moving}
      swap={swapFollowed}
      testID="wall-glow"
      beforeFrost={
        fadeStyle === null ? null : swapFollowed ? (
          <SwapLabelFade
            frames={swapFollowed.frames}
            fades={swapFades}
            held={heldFade}
            strongest={fade}
            style={fadeStyle}
          />
        ) : (
          <View style={fadeStyle} testID="wall-glow-label-fade" />
        )
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
