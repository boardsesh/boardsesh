import React, { useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import type { BoardName } from '@boardsesh/shared-schema';
import { useNativeClimbRender } from '../hooks/use-native-climb-render';
import { canWarmBoardArtMemory, warmBoardArtMemory } from '../lib/board-render/warm-board-art-memory';
import { useTheme } from '../providers/theme-provider';
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

/**
 * Overlay + background width for a thumbnail cell: ~5× the cell width (≥400px,
 * covering the default 76px cell at up to ~3× DPR and a ~100px hero cell at ~4×)
 * so expo-image never has to downscale a ~1080px source on the main thread while
 * scrolling. One function, because the width is part of the overlay cache key:
 * the thumbnail and its prewarm below have to ask for the same PNG.
 */
function thumbnailRenderWidth(cellWidth: number): number {
  return Math.max(400, Math.round(cellWidth * 5));
}

type ClimbListThumbnailPrewarmProps = {
  frames: string;
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
};

/**
 * Renders a list thumbnail's holds overlay before its row exists, and decodes it
 * into expo-image's memory cache. Draws nothing.
 *
 * A row that mounts onto a climb nobody has rendered yet shows the bare board
 * until the native render, the PNG decode and a cross-fade have all finished —
 * the "board first, holds flash in later" a fast scroll is full of. The climbs
 * list mounts one of these for each loaded climb just past the viewport, so by
 * the time the row arrives the overlay is an index hit and a memory-cache hit,
 * and it paints with the board.
 *
 * `prefetch` puts the render at the scheduler's idle-only rank: it never takes a
 * slot from a thumbnail somebody can already see.
 */
export const ClimbListThumbnailPrewarm = React.memo(function ClimbListThumbnailPrewarm({
  frames,
  boardName,
  layoutId,
  sizeId,
  setIds,
}: ClimbListThumbnailPrewarmProps) {
  const { overlayUri } = useNativeClimbRender({
    frames,
    boardName,
    layoutId,
    sizeId,
    setIds,
    // Must match ClimbListThumbnail's call exactly, or this warms a PNG no row
    // ever looks up.
    filledStyle: true,
    renderWidth: thumbnailRenderWidth(THUMBNAIL_WIDTH),
    prefetch: true,
  });
  useEffect(() => {
    if (overlayUri) warmBoardArtMemory([overlayUri]);
  }, [overlayUri]);
  return null;
});

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
  const { systemColors } = useTheme();
  const cellWidth = size?.width ?? THUMBNAIL_WIDTH;
  const cellHeight = size?.height ?? THUMBNAIL_HEIGHT;
  const {
    overlayUri,
    overlayLoadKey,
    overlayImmediate,
    overlayUnavailable,
    onOverlayLoad,
    onOverlayError,
    backgroundPaths,
    missingBackgroundCount,
    backgroundBaseColor,
  } = useNativeClimbRender({
    frames,
    boardName,
    layoutId,
    sizeId,
    setIds,
    filledStyle: true,
    renderWidth: thumbnailRenderWidth(cellWidth),
  });

  return (
    <View style={[styles.container, size ? { width: cellWidth, height: cellHeight } : null]}>
      <LayeredClimbImage
        overlayUri={overlayUri}
        overlayLoadKey={overlayLoadKey}
        onOverlayLoad={onOverlayLoad}
        onOverlayError={onOverlayError}
        backgroundPaths={backgroundPaths}
        baseColor={backgroundBaseColor}
        missingBackgroundCount={missingBackgroundCount}
        mirrored={mirrored}
        recyclingKey={frames}
        // Already rendered when the row took this climb (a revisit, or a row the
        // list warmed ahead of the scroll) AND decoded into memory by that
        // warm-up: it paints with the board, so a cross-fade from nothing would
        // only put the bare board on screen. Where the warm-up cannot run
        // (Android) the overlay still decodes after the board is up; keep the
        // fade there.
        suppressOverlayTransition={overlayImmediate && canWarmBoardArtMemory}
        // Not rendered yet: hold the whole thumbnail back until its holds have
        // painted. Never for an overlay that is not coming.
        revealWithOverlay={frames.length > 0 && !overlayImmediate && !overlayUnavailable ? 'each-climb' : undefined}
        revealPlaceholderColor={systemColors.fill}
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
