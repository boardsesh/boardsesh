import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { FrostedBokeh } from '../FrostedBokeh';
import type { WallGlowLayer } from './use-wall-glow';

/** The button's readable label zone, checked by wallGlowLabelFade. */
const FADE_LEFT = 0.12;
const FADE_WIDTH = 0.76;

type WallGlowProps = {
  layer: WallGlowLayer;
  width: number;
};

function WallGlowComponent({ layer, width }: WallGlowProps) {
  const { surface, fade } = layer;
  const fadeGradient =
    fade > 0
      ? `linear-gradient(to right, transparent 0%, ${baseWithAlpha(surface.base, fade)} 10%, ${baseWithAlpha(surface.base, fade)} 90%, transparent 100%)`
      : null;

  return (
    <FrostedBokeh
      layer={layer}
      testID="wall-glow"
      beforeFrost={
        fadeGradient ? (
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
  fade: {
    position: 'absolute',
    top: 0,
    bottom: 0,
  },
});
