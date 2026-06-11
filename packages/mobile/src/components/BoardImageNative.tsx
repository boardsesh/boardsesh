import React from 'react';
import { View, type ViewStyle } from 'react-native';
import type { BoardName } from '@boardsesh/shared-schema';
import { useNativeClimbRender } from '../hooks/use-native-climb-render';
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
  style?: ViewStyle;
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
  style,
}: BoardImageNativeProps) {
  const { overlayUri, backgroundPaths, missingBackgroundCount } = useNativeClimbRender({
    frames,
    boardName,
    layoutId,
    sizeId,
    setIds,
    filledStyle,
    renderWidth,
  });

  const allowDownscaling = renderWidth == null;
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
        allowDownscaling={allowDownscaling}
      />
    </View>
  );
});

export { BoardImageNative };
