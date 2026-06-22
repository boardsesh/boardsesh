import React from 'react';
import { View, type ViewStyle } from 'react-native';
import type { BoardName } from '@boardsesh/shared-schema';
import { useNativeClimbRender } from '../hooks/use-native-climb-render';
import type { BackgroundVariant } from '../lib/background-image-cache';
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
   * releases the previous climb's decoded overlay bitmap when this stays mounted
   * but the climb changes (the play-drawer carousel swapping climbs). Without it,
   * the old full-size overlay lingers in the in-memory cache alongside the new
   * one. Key it on the per-climb `frames`.
   */
  recyclingKey?: string;
  style?: ViewStyle;
  /**
   * testID forwarded to the holds-overlay layer, which only mounts once the async
   * overlay render is ready — lets screenshot/e2e flows wait for the lit board to
   * appear. The full-size play-drawer board sets this; thumbnails leave it unset.
   */
  overlayTestID?: string;
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
  overlayTestID,
}: BoardImageNativeProps) {
  const { overlayUri, backgroundPaths, missingBackgroundCount } = useNativeClimbRender({
    frames,
    boardName,
    layoutId,
    sizeId,
    setIds,
    filledStyle,
    renderWidth,
    backgroundVariant,
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
        backgroundPaths={backgroundPaths}
        missingBackgroundCount={missingBackgroundCount}
        mirrored={mirrored}
        recyclingKey={recyclingKey}
        overlayTestID={overlayTestID}
      />
    </View>
  );
});

export { BoardImageNative };
