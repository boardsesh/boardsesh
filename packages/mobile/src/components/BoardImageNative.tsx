import React from 'react';
import { View, type ViewStyle } from 'react-native';
import type { BoardName } from '@boardsesh/shared-schema';
import { useNativeClimbRender } from '../hooks/use-native-climb-render';
import type { BackgroundVariant } from '../lib/background-image-cache';
import type { BoardRenderSettings } from '../lib/board-render-settings';
import { LayeredClimbImage } from './LayeredClimbImage';

type BoardImageNativeProps = {
  frames: string;
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  boardWidth: number;
  boardHeight: number;
  mirrored?: boolean;
  /**
   * Render lit holds as filled dots (filled style) instead of the default
   * stroke-only outlines. The full-size play view leaves this false — thin
   * strokes stay legible when large — but small surfaces like the 40×40
   * accessory thumbnail pass true so holds read as solid dots once scaled
   * down. Threaded into the render cache key, so the two styles cache as
   * separate PNGs (see useNativeClimbRender).
   */
  filledStyle?: boolean;
  /**
   * Target overlay/background width in px for small surfaces (e.g. the
   * 40×40 accessory thumbnail). Forwarded to useNativeClimbRender so the
   * Rust renderer + bundled background resolve at a small size instead of
   * the board's native ~1080px — avoiding a main-thread downscale. Omit
   * for the full-size play view (renders at native board width).
   */
  renderWidth?: number;
  /**
   * Force the bundled board-photo resolution independently of `renderWidth`.
   * The play-drawer carousel passes `renderWidth` (display-sized overlay) +
   * `backgroundVariant="full"` (crisp shared photo). See useNativeClimbRender.
   */
  backgroundVariant?: BackgroundVariant;
  /**
   * Forwarded to the holds-overlay <Image> so expo-image recycles the view and
   * releases the previous climb's decoded overlay when this stays mounted but
   * the climb changes (the play-drawer carousel swapping climbs). Key it on the
   * per-climb `frames`.
   */
  recyclingKey?: string;
  style?: ViewStyle;
  /**
   * Drop the holds overlay's cross-fade for this render — forwarded to
   * LayeredClimbImage. The play-drawer carousel sets it on the current board while
   * committing a swipe so the new climb's (already-cached) holds swap instantly
   * instead of fading up, which removed the Android end-of-swipe flash.
   */
  suppressOverlayTransition?: boolean;
  /**
   * testID forwarded to the holds-overlay layer, which only mounts once the async
   * overlay render is ready — lets screenshot/e2e flows wait for the lit board to
   * appear. The full-size play-drawer board sets this; thumbnails leave it unset.
   */
  overlayTestID?: string;
  /**
   * Draw under a different board-render settings bundle than the climber's
   * stored one — the board-look carousel's preview cards. Only the board-render
   * half is substituted: hold colours and marker shapes still come from the
   * global override store, so picking a preset can never be a back door into the
   * accessibility store. To vary the COLOURS of a preview instead, pass
   * `holdColorTransform` below — the two props are the board half and the colour
   * half of the same "draw this card differently" seam, and either can be used
   * without the other. Must be referentially stable; see `useNativeClimbRender`.
   */
  renderSettingsOverride?: BoardRenderSettings;
  /**
   * Redraw this preview's hold colours through a read-only transform, applied
   * after the climber's overrides and the board's display palette resolve — the
   * colour-blind check carousel simulating each dichromacy on the climber's own
   * board. Never writes the override store, so it cannot reach the physical
   * board's LEDs.
   *
   * Only the holds overlay is simulated; the board photograph underneath is
   * drawn as-is (expo-image has no colour-matrix prop). These cards answer "can
   * I still tell my hold roles apart?", not "how does the wall look?".
   *
   * Must be referentially stable — a module constant — and must be paired with
   * `holdColorTransformKey`. See `useNativeClimbRender`.
   */
  holdColorTransform?: (hex: string) => string;
  /**
   * Identity of `holdColorTransform` (e.g. `'cvd-deuteranopia'`), folded into
   * the render cache key so each simulated card caches as its own PNG and
   * cannot displace the real board's. Required whenever the transform is set.
   */
  holdColorTransformKey?: string;
};

/**
 * Full-size layered board image, suited for the PlayView drawer and the
 * climb detail page. Wraps the shared LayeredClimbImage stack in an
 * aspect-ratio-locked container so the bundled board background and
 * holds-only overlay line up perfectly regardless of native source
 * dimensions.
 *
 * Mirrors via CSS to match the SVG renderer's behavior (background +
 * holds flipped together) — the Rust `mirrored` flag is intentionally
 * not used here, so a single cached PNG serves both orientations.
 */
const BoardImageNative = React.memo(function BoardImageNative({
  frames,
  boardName,
  layoutId,
  sizeId,
  setIds,
  boardWidth,
  boardHeight,
  mirrored,
  filledStyle = false,
  renderWidth,
  backgroundVariant,
  recyclingKey,
  style,
  suppressOverlayTransition,
  overlayTestID,
  renderSettingsOverride,
  holdColorTransform,
  holdColorTransformKey,
}: BoardImageNativeProps) {
  const { overlayUri, overlayLoadKey, onOverlayLoad, onOverlayError, backgroundPaths, missingBackgroundCount } =
    useNativeClimbRender({
      frames,
      boardName,
      layoutId,
      sizeId,
      setIds,
      filledStyle,
      renderWidth,
      backgroundVariant,
      renderSettingsOverride,
      holdColorTransform,
      holdColorTransformKey,
    });

  const containerStyle: ViewStyle = {
    width: '100%',
    aspectRatio: boardWidth / boardHeight,
    ...style,
  };

  return (
    <View style={containerStyle}>
      <LayeredClimbImage
        overlayUri={overlayUri}
        overlayLoadKey={overlayLoadKey}
        onOverlayLoad={onOverlayLoad}
        onOverlayError={onOverlayError}
        backgroundPaths={backgroundPaths}
        missingBackgroundCount={missingBackgroundCount}
        mirrored={mirrored}
        recyclingKey={recyclingKey}
        suppressOverlayTransition={suppressOverlayTransition}
        overlayTestID={overlayTestID}
      />
    </View>
  );
});

export { BoardImageNative };
