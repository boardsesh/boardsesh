import React from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { type AnimatedStyle } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { brandColorsDark, withAlpha } from '../../theme/colors';
import { overlays } from '../../theme/tokens';

/** How tall the band is, in points. */
export const SCAN_BAND_HEIGHT = 64;

/**
 * The light violet, whatever the scheme: the band always runs over a dimmed
 * photograph, where the dark-scheme violet is the one that reads.
 */
const BAND_VIOLET = brandColorsDark.primary;

// A glow that thickens towards a bright leading edge, so the band reads as
// moving downwards even in a still frame.
const BAND_COLORS = [
  withAlpha(BAND_VIOLET, 0),
  withAlpha(BAND_VIOLET, 0.32),
  withAlpha(overlays.onScrim, 0.85),
] as const;
const BAND_LOCATIONS = [0, 0.92, 1] as const;

/**
 * The scan band: a 64 pt gradient strip, full width of its parent, positioned
 * by an animated style from the caller. Presentational only. The scan step
 * loops it over the photo while the detector runs, and the editor runs it once
 * down the leading edge of the ring reveal, so the two read as one motion.
 */
export const SprayScanBand = React.memo(function SprayScanBand({
  style,
}: {
  style: StyleProp<AnimatedStyle<StyleProp<ViewStyle>>>;
}) {
  return (
    <Animated.View pointerEvents="none" style={[styles.band, style]}>
      <LinearGradient colors={BAND_COLORS} locations={BAND_LOCATIONS} style={StyleSheet.absoluteFill} />
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  band: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: SCAN_BAND_HEIGHT,
  },
});
