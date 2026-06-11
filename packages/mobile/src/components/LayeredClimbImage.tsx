import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Image } from 'expo-image';

type LayeredClimbImageProps = {
  overlayUri: string | null;
  backgroundPaths: string[];
  /**
   * Number of background layers the cache couldn't resolve. Each missing
   * layer is rendered as a visible neutral-gray block so the bug is
   * reportable instead of invisibly-broken. Per the no-network rule we
   * never fall back to a server.
   */
  missingBackgroundCount?: number;
  mirrored?: boolean;
  /**
   * Darken the board photo (a scrim drawn between the background images and
   * the holds overlay) so the unlit physical holds recede and the lit
   * overlay pops. The list thumbnail sets this at small sizes; the
   * full-size play view leaves it off so the real board photo stays bright.
   * View-layer only — not baked into the cached PNG, so no cache-key impact.
   */
  dimBackground?: boolean;
  recyclingKey?: string;
  /**
   * Passed through to expo-image. Full-size play-view renders use native-size
   * sources and need downscaling to fit the board box; pre-sized thumbnails pass
   * false because their sources already match the surface.
   */
  allowDownscaling?: boolean;
};

/**
 * The shared 2-layer climb image stack used by both the list thumbnail
 * and the full-size play-view renderer. Bundled board background images
 * render synchronously underneath; the holds-only overlay PNG (from the
 * Rust renderer) fades in on top once available. Both layers use
 * contentFit="contain" so the native-resolution overlay scales cleanly
 * to whatever box the parent provides.
 *
 * This component assumes the parent provides positioning + sizing — it
 * fills its parent via absolute layers. Mirror flips the entire stack
 * together so a single cached overlay PNG serves both orientations.
 */
const LayeredClimbImage = React.memo(function LayeredClimbImage({
  overlayUri,
  backgroundPaths,
  missingBackgroundCount = 0,
  mirrored,
  dimBackground,
  recyclingKey,
  allowDownscaling = true,
}: LayeredClimbImageProps) {
  return (
    <View style={[styles.stack, mirrored && styles.mirrored]}>
      {backgroundPaths.map((path) => (
        <Image
          key={path}
          source={{ uri: `file://${path}` }}
          style={styles.layer}
          contentFit="contain"
          cachePolicy="memory-disk"
          allowDownscaling={allowDownscaling}
        />
      ))}
      {missingBackgroundCount > 0 &&
        // Render one visible gray block per missing background layer. No
        // server fallback (no-network rule) — the user must SEE a missing
        // layer instead of an invisibly-incomplete render so they can
        // report it. Index keys are fine here: the count is deterministic
        // for a given board config and these placeholders have no state.
        Array.from({ length: missingBackgroundCount }, (_, layerIndex) => (
          <View
            key={`missing-${layerIndex}`}
            style={[styles.layer, styles.missingLayer]}
            accessibilityLabel="Missing background layer"
          />
        ))}
      {/* Scrim sits above the board photo, below the holds overlay, so the
          lit climb reads against a quieted board at thumbnail size. */}
      {dimBackground && <View style={[styles.layer, styles.dim]} pointerEvents="none" />}
      {overlayUri && (
        <Image
          source={{ uri: overlayUri }}
          style={styles.layer}
          contentFit="contain"
          recyclingKey={recyclingKey}
          cachePolicy="memory-disk"
          transition={150}
          allowDownscaling={allowDownscaling}
        />
      )}
    </View>
  );
});

export { LayeredClimbImage };

const styles = StyleSheet.create({
  stack: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  layer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  // Visible-but-not-screaming neutral gray: the user can see and report
  // a missing layer ("the play view has a gray rectangle"), but it isn't
  // so loud it looks like a crash. The whole point of the no-network
  // rule is that broken renders must be visible-broken.
  missingLayer: {
    backgroundColor: 'rgba(120, 120, 128, 0.18)',
  },
  // Subtle list-only board scrim. Tunable: drop dimBackground if the filled
  // hold style already separates the climb on a given board / in light mode.
  dim: {
    backgroundColor: 'rgba(0, 0, 0, 0.18)',
  },
  mirrored: {
    transform: [{ scaleX: -1 }],
  },
});
