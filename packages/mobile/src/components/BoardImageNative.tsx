import React, { type ReactNode } from 'react';
import { View, type ViewStyle } from 'react-native';
import type { BoardName } from '@boardsesh/shared-schema';
import { useNativeClimbRender } from '../hooks/use-native-climb-render';
import type { BackgroundVariant } from '../lib/background-image-cache';
import type { BoardRenderSettings } from '../lib/board-render-settings';
import type { HoldColorOverrides } from '../lib/hold-color-overrides';
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
   * This is THE board the climber is looking at — the play drawer's current
   * card. Sets `surface: 'play'` on render-failure telemetry and turns on the
   * overlay paint watchdog. Every other call site (preview cards and rails, the
   * preview sheet, the reaction menu, the wall kiosk hero, the carousel's
   * off-screen peek) leaves it off: pooling those into one rate would describe
   * nothing anybody experienced.
   */
  playSurface?: boolean;
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
   * Ceiling for the veil — the wash over the unlit wall. Editing surfaces pass
   * `EDITING_MAX_VEIL_OPACITY` so the holds a climber still has to find and tap
   * do not disappear into it. Only ever lowers; see `useNativeClimbRender`.
   */
  maxVeilOpacity?: number;
  /**
   * Hold the last painted overlay while the next one renders — for surfaces
   * whose frames change on every tap. See `LayeredClimbImage`.
   */
  retainPreviousOverlay?: boolean;
  /**
   * Drawn while no overlay has ever painted, i.e. when the native renderer is
   * unavailable and none is coming. Lets a surface that must show its holds
   * degrade to a JS-drawn layer instead of showing none.
   */
  emptyOverlayFallback?: ReactNode;
  /**
   * Draw under a different board-render settings bundle than the climber's
   * stored one — the board-look carousel's preview cards. Only the board-render
   * half is substituted: hold colours and marker shapes still come from the
   * global override store, so picking a preset can never be a back door into the
   * accessibility store. To vary the COLOURS of a preview instead, pass
   * `holdColorOverride` below — the two props are the board half and the colour
   * half of the same "draw this card differently" seam, and either can be used
   * without the other. Must be referentially stable; see `useNativeClimbRender`.
   */
  renderSettingsOverride?: BoardRenderSettings;
  /**
   * Draw this preview's four hold roles in a different set of colours than the
   * climber's stored ones — the colour-vision palette rail, whose cards each
   * show the same board under a different palette. Never writes the override
   * store, so previewing a palette cannot reach the physical board's LEDs.
   *
   * `{}` draws the board's own shipped palette; `undefined` reads the store.
   * Must be referentially stable; see `useNativeClimbRender`.
   */
  holdColorOverride?: HoldColorOverrides;
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
  playSurface = false,
  renderWidth,
  backgroundVariant,
  recyclingKey,
  style,
  suppressOverlayTransition,
  overlayTestID,
  renderSettingsOverride,
  holdColorOverride,
  maxVeilOpacity,
  retainPreviousOverlay,
  emptyOverlayFallback,
}: BoardImageNativeProps) {
  const {
    overlayUri,
    overlayLoadKey,
    onOverlayLoad,
    onOverlayError,
    onOverlayMounted,
    backgroundPaths,
    missingBackgroundCount,
    rendererUnavailable,
  } = useNativeClimbRender({
    frames,
    boardName,
    layoutId,
    sizeId,
    setIds,
    filledStyle,
    playSurface,
    renderWidth,
    backgroundVariant,
    renderSettingsOverride,
    holdColorOverride,
    maxVeilOpacity,
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
        onOverlayMounted={onOverlayMounted}
        backgroundPaths={backgroundPaths}
        missingBackgroundCount={missingBackgroundCount}
        mirrored={mirrored}
        recyclingKey={recyclingKey}
        suppressOverlayTransition={suppressOverlayTransition}
        overlayTestID={overlayTestID}
        retainPreviousOverlay={retainPreviousOverlay}
        overlayIdentity={`${boardName}-${layoutId}-${sizeId}-${setIds}`}
        // Only once the loader has given up: a null overlay during an ordinary
        // cold render is "not yet", and showing the fallback there would flash
        // JS-drawn holds before the real ones on every capable device.
        emptyOverlayFallback={rendererUnavailable ? emptyOverlayFallback : undefined}
      />
    </View>
  );
});

export { BoardImageNative };
