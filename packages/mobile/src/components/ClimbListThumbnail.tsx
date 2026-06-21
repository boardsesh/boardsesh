import React from 'react';
import { View, StyleSheet } from 'react-native';
import type { BoardName } from '@boardsesh/shared-schema';
import { useNativeClimbRender } from '../hooks/use-native-climb-render';
import { borderRadius } from '../theme/tokens';
import { LayeredClimbImage } from './LayeredClimbImage';
import { THUMBNAIL_HEIGHT, THUMBNAIL_WIDTH } from './climb-list-thumbnail-metrics';

/**
 * Portrait dimensions of the list thumbnail cell. Exported so ClimbListRow
 * can size its wrapper and align the row separator to the thumbnail's right
 * edge from a single source of truth. Portrait (not square) so the portrait
 * board image fills the cell instead of letterboxing to ~40px wide.
 */
export { THUMBNAIL_HEIGHT, THUMBNAIL_WIDTH };

type ClimbListThumbnailProps = {
  frames: string;
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  mirrored?: boolean;
  /**
   * Override the fixed 76×96 list cell. The session feed hero passes a larger
   * size (~100×128); ClimbListRow omits it and keeps the default. The internal
   * render width scales with `width` so the enlarged cell stays crisp.
   */
  size?: { width: number; height: number };
};

/**
 * Layered climb thumbnail for the list view. Wraps the shared
 * LayeredClimbImage stack in a fixed 76×96 portrait cell (override via `size`)
 * with rounded corners, using the filled hold style so the lit climb reads as
 * solid dots against the board photo at this small size.
 *
 * Mirror via CSS only — passing `mirrored` to the Rust renderer too
 * would double-flip, and we'd cache two PNGs per climb instead of one.
 * BoardImageNative (the play-view full-size renderer) follows the same
 * pattern.
 */
const ClimbListThumbnail = React.memo(function ClimbListThumbnail({
  frames,
  boardName,
  layoutId,
  sizeId,
  setIds,
  mirrored,
  size,
}: ClimbListThumbnailProps) {
  const cellWidth = size?.width ?? THUMBNAIL_WIDTH;
  const cellHeight = size?.height ?? THUMBNAIL_HEIGHT;
  const { overlayUri, backgroundPaths, missingBackgroundCount } = useNativeClimbRender({
    frames,
    boardName,
    layoutId,
    sizeId,
    setIds,
    filledStyle: true,
    // Render the overlay + resolve the background at ~5× the cell width (≥400px,
    // covering the default 76px cell at up to ~3× DPR and a ~100px hero cell at
    // ~4×) so expo-image never has to downscale a ~1080px source on the main
    // thread while scrolling.
    renderWidth: Math.max(400, Math.round(cellWidth * 5)),
  });

  return (
    <View style={[styles.container, size ? { width: cellWidth, height: cellHeight } : null]}>
      <LayeredClimbImage
        overlayUri={overlayUri}
        backgroundPaths={backgroundPaths}
        missingBackgroundCount={missingBackgroundCount}
        mirrored={mirrored}
        recyclingKey={frames}
      />
    </View>
  );
});

export { ClimbListThumbnail };

const styles = StyleSheet.create({
  container: {
    width: THUMBNAIL_WIDTH,
    height: THUMBNAIL_HEIGHT,
    borderRadius: borderRadius.md,
    overflow: 'hidden',
  },
});
