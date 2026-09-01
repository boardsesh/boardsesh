import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, View, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import type { ImageErrorEventData } from 'expo-image';
import { useIsAppBackgrounded } from '../lib/app-visibility';
import { useBoardArtVisible } from './board-art-visibility-context';

type LayeredClimbImageProps = {
  overlayUri: string | null;
  /**
   * Generation + per-consumer attempt identity. React's key must change when a
   * missing overlay is regenerated at the same URI: Android expo-image does not
   * reliably reload that case from recyclingKey alone.
   */
  overlayLoadKey?: string | null;
  onOverlayLoad?: (loadKey: string | null) => void;
  onOverlayError?: (event: ImageErrorEventData, loadKey: string | null) => void;
  /**
   * Report whether an overlay `<Image>` is MOUNTED: its load key while one is,
   * `null` the moment there is none.
   *
   * This component renders no image at all while hidden (see `hidden` below), so
   * `overlayUri` being set is not the same question as "something is on screen
   * that can call `onLoad`". Anything waiting on a paint has to key off this,
   * not off the URI.
   */
  onOverlayMounted?: (mountedLoadKey: string | null) => void;
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
  /**
   * Drop the holds overlay's 150ms cross-fade for this render. The play-drawer
   * carousel sets this while committing a swipe: the incoming climb's overlay is
   * already a memory-cache hit (the peek painted it during the drag), so an instant
   * swap lands the new holds on the very next frame instead of fading them up —
   * which on Android was the visible end-of-swipe flash at centre.
   */
  suppressOverlayTransition?: boolean;
  recyclingKey?: string;
  /**
   * testID for the holds-overlay layer. Only rendered once the async overlay PNG
   * is ready, so screenshot/e2e flows can anchor on "the lit climb has rendered"
   * (the full-size play view sets this; thumbnails leave it unset).
   */
  overlayTestID?: string;
  /**
   * Opt into keeping the last overlay that actually painted mounted underneath
   * while the next one renders, by passing the identity of the board it belongs
   * to. Undefined (the default) retains nothing.
   *
   * `overlayUri` goes null the instant the cache key moves — the guard that
   * stops a recycled list row showing the previous climb's holds. On a surface
   * that re-renders on every tap (the create editor) that guard would blank
   * every painted hold for the length of a render. Retaining the last frame
   * bridges the gap; the cross-fade is forced off while it is on, because a
   * hold you just erased would otherwise linger at full opacity underneath the
   * fading-in replacement.
   *
   * The identity is carried by this prop rather than a separate one so the two
   * cannot be set apart: a retained frame with no identity would survive a board
   * change and paint the old wall's holds over the new one.
   */
  retainPreviousOverlayFor?: string;
  /**
   * Drawn in place of the overlay while no overlay has ever painted — i.e. when
   * the native renderer is missing entirely (Expo Go, a binary that predates it)
   * and `overlayUri` would stay null forever. Lets a surface that MUST show its
   * holds degrade to a JS-drawn layer instead of showing none.
   */
  emptyOverlayFallback?: ReactNode;
};

export function backgroundImageUri(path: string): string {
  if (Platform.OS === 'web' || path.includes('://')) return path;
  return `file://${path}`;
}

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
  overlayLoadKey,
  onOverlayLoad,
  onOverlayError,
  onOverlayMounted,
  backgroundPaths,
  missingBackgroundCount = 0,
  mirrored,
  dimBackground,
  suppressOverlayTransition,
  recyclingKey,
  overlayTestID,
  retainPreviousOverlayFor,
  emptyOverlayFallback,
}: LayeredClimbImageProps) {
  const shouldShowEmptyFallback = backgroundPaths.length === 0 && missingBackgroundCount === 0;
  // Only relevant when overlayTestID is set (the play-drawer board): expose the
  // testID anchor on a marker that mounts AFTER the overlay image has actually
  // painted, not when the <Image> first mounts. expo-image reports "visible" to
  // Maestro the moment it's in the tree (even with a cached source, before the
  // pixels land), so anchoring on the raw <Image> let a screenshot fire on a
  // blank drawer. Gating on onLoad makes the anchor mean "the lit board is on
  // screen".
  const [overlayPainted, setOverlayPainted] = useState(false);
  // Native image events can already be queued when React replaces an overlay.
  // Keep the currently rendered attempt in a ref so an old image cannot expose
  // the screenshot anchor after the replacement reset it. The recovery owner
  // still receives the captured key below and independently rejects stale cache
  // events; this guard owns the component-local painted marker.
  const latestOverlayAttemptRef = useRef({ uri: overlayUri, loadKey: overlayLoadKey ?? null });
  latestOverlayAttemptRef.current = { uri: overlayUri, loadKey: overlayLoadKey ?? null };

  // Drop the decoded board-art bitmaps whenever this surface is hidden: render an
  // empty stack so expo-image releases their GPU textures + native-heap bitmaps
  // (the views stay mounted, so without this they pin ~100 MB+ that raises the OS
  // kill risk). Two hidden cases, both re-decoding from disk in tens of ms when
  // shown again: the app is backgrounded (#3479), or — on iPad — this tab is not
  // the focused one but stays mounted (`detachInactiveScreens={false}`), so its
  // off-screen bitmaps would otherwise linger for the whole session (#3803, see
  // BoardArtVisibilityProvider).
  const isBackgrounded = useIsAppBackgrounded();
  const boardArtVisible = useBoardArtVisible();
  const hidden = isBackgrounded || !boardArtVisible;
  // The last overlay that reported onLoad, kept only while retention is opted
  // into. Decorative: it never feeds the load-key accounting or the testID anchor.
  const [retainedOverlay, setRetainedOverlay] = useState<{ uri: string; identity: string } | null>(null);
  const retainIdentity = retainPreviousOverlayFor;
  // While hidden, reset the overlay-painted anchor so it re-gates on the next
  // real onLoad after this shows again, not before the lit board.
  useEffect(() => {
    if (!hidden) return;
    setOverlayPainted(false);
    // A retained frame must not survive the surface being hidden: coming back
    // would paint the stale holds under a render that has not happened yet.
    setRetainedOverlay(null);
  }, [hidden]);
  // Different board — the retained frame belongs to a wall that is no longer here.
  useEffect(() => {
    setRetainedOverlay(null);
  }, [retainIdentity]);

  useEffect(() => {
    setOverlayPainted(false);
  }, [overlayUri, overlayLoadKey]);
  // Mirror the exact condition the overlay `<Image>` below renders under, so a
  // consumer waiting on a paint learns the instant there is nothing left to
  // paint — the app backgrounding, or this tab's board art being released while
  // the component stays mounted. The cleanup covers unmount as well.
  const overlayMountedKey = !hidden && overlayUri ? (overlayLoadKey ?? null) : null;
  const overlayImageMounted = !hidden && !!overlayUri;
  useEffect(() => {
    onOverlayMounted?.(overlayImageMounted ? overlayMountedKey : null);
    return () => onOverlayMounted?.(null);
  }, [onOverlayMounted, overlayImageMounted, overlayMountedKey]);
  const bridgeOverlay =
    retainIdentity != null && retainedOverlay?.identity === retainIdentity && retainedOverlay.uri !== overlayUri
      ? retainedOverlay.uri
      : null;
  if (hidden) {
    return <View style={[styles.stack, mirrored && styles.mirrored]} />;
  }

  return (
    <View style={[styles.stack, mirrored && styles.mirrored]}>
      {shouldShowEmptyFallback && (
        <View testID="layered-climb-image-empty-fallback" style={[styles.layer, styles.emptyLayer]} />
      )}
      {backgroundPaths.map((path) => (
        <Image
          key={path}
          source={{ uri: backgroundImageUri(path) }}
          style={styles.layer}
          contentFit="contain"
          cachePolicy="memory-disk"
          // Skip expo-image's main-thread downscale resample (the iOS app
          // hang). Sources are already sized to the surface — thumb-variant
          // backgrounds for the list, native-res for the play view — so
          // there's nothing large to downscale; the CALayer scales to fit.
          allowDownscaling={false}
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
      {/* Bridge layer: the previous overlay, held while the next one renders so a
          per-tap surface never blanks. Decorative only — no onLoad/onError, no
          recyclingKey, no testID — so it cannot disturb the live overlay's
          exact-attempt accounting. */}
      {bridgeOverlay && (
        <Image
          key={`retained-${bridgeOverlay}`}
          source={{ uri: bridgeOverlay }}
          style={styles.layer}
          contentFit="contain"
          cachePolicy="memory-disk"
          transition={0}
          allowDownscaling={false}
          pointerEvents="none"
        />
      )}
      {/* No overlay has ever painted and none is coming (no native renderer):
          let the caller draw the holds itself rather than showing none. */}
      {!overlayUri && !bridgeOverlay && emptyOverlayFallback}
      {overlayUri && (
        <Image
          key={overlayLoadKey ?? overlayUri}
          source={{ uri: overlayUri }}
          style={styles.layer}
          contentFit="contain"
          recyclingKey={recyclingKey}
          cachePolicy="memory-disk"
          // Forced instant while retaining: a hold erased on this tap would
          // otherwise stay visible on the bridge layer for the whole fade.
          transition={suppressOverlayTransition || retainIdentity != null ? 0 : 150}
          // Overlay PNG is rasterized at the surface size (small for the
          // list/accessory, native for play) so no main-thread downscale
          // is needed — skip expo-image's resample.
          allowDownscaling={false}
          onLoad={() => {
            const emittingLoadKey = overlayLoadKey ?? null;
            const latestAttempt = latestOverlayAttemptRef.current;
            if (retainIdentity != null && latestAttempt.uri === overlayUri) {
              setRetainedOverlay((previous) =>
                previous?.uri === overlayUri && previous.identity === retainIdentity
                  ? previous
                  : { uri: overlayUri, identity: retainIdentity },
              );
            }
            if (overlayTestID && latestAttempt.uri === overlayUri && latestAttempt.loadKey === emittingLoadKey) {
              setOverlayPainted(true);
            }
            onOverlayLoad?.(emittingLoadKey);
          }}
          onError={(event) => onOverlayError?.(event, overlayLoadKey ?? null)}
        />
      )}
      {/* Screenshot/e2e anchor — see overlayPainted above. Transparent, full-bleed
          (so it has on-screen bounds Maestro can see), and pointer-transparent. */}
      {overlayTestID && overlayPainted && <View testID={overlayTestID} style={styles.layer} pointerEvents="none" />}
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
    backgroundColor: 'rgba(120, 120, 128, 0.28)',
  },
  emptyLayer: {
    backgroundColor: 'rgba(120, 120, 128, 0.28)',
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
