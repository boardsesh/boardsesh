import React, { useEffect, useRef, type MutableRefObject } from 'react';
import { PixelRatio, View, StyleSheet } from 'react-native';
import type { BoardName } from '@boardsesh/shared-schema';
import { useNativeClimbRender } from '../hooks/use-native-climb-render';
import { isBoardArtInMemory, warmBoardArtMemory } from '../lib/board-render/warm-board-art-memory';
import { useTheme } from '../providers/theme-provider';
import { borderRadius } from '../theme/tokens';
import { LayeredClimbImage } from './LayeredClimbImage';
import { useClimbListThumbnailSize } from './climb-list-thumbnail-metrics';
import type { ReadyBoardArtSource } from '../lib/board-render/ready-board-art';

/** The overlay width every list cell renders at, and the MiniPlayer accessory's: the `_w400_` cache key. */
const LIST_RENDER_WIDTH_FLOOR = 400;

/**
 * Overlay + background width for a cell whose caller passed its own `size` (feed
 * cards, notifications, the session hero): ~5× the cell width, at least 400px,
 * so expo-image never has to downscale a ~1080px source on the main thread while
 * scrolling. Unchanged since those sizes shipped, so their cached PNGs stay valid.
 */
function sizedThumbnailRenderWidth(cellWidth: number): number {
  return Math.max(LIST_RENDER_WIDTH_FLOOR, Math.round(cellWidth * 5));
}

/**
 * Overlay + background width for a climb list cell: its pixel width with 25%
 * headroom, never under 400px. 76pt at 3× is 285px and 88pt at 2× (iPad) is
 * 220px, so both land on 400 and share the `_w400_` key with the MiniPlayer
 * accessory (`AccessoryClimbThumbnail`): a climb seen in the list paints there
 * from cache. 5× would have made the 88pt cell 440px and its own key. One
 * function, because the width is part of the overlay cache key: the thumbnail
 * and its prewarm below have to ask for the same PNG.
 */
function listThumbnailRenderWidth(cellWidth: number): number {
  return Math.max(LIST_RENDER_WIDTH_FLOOR, Math.ceil(cellWidth * PixelRatio.get() * 1.25));
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
 * list mounts one of these for each loaded climb just outside the viewport, so
 * by the time the row arrives the overlay is an index hit and a memory-cache
 * hit, and it paints with the board.
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
  const { width: cellWidth } = useClimbListThumbnailSize();
  const { overlayUri } = useNativeClimbRender({
    frames,
    boardName,
    layoutId,
    sizeId,
    setIds,
    // Must match ClimbListThumbnail's call exactly, or this warms a PNG no row
    // ever looks up.
    filledStyle: true,
    renderWidth: listThumbnailRenderWidth(cellWidth),
    prefetch: true,
  });
  useEffect(() => {
    // Rows just above the viewport were on screen a moment ago and are usually
    // still decoded; nothing to ask for then.
    if (overlayUri && !isBoardArtInMemory(overlayUri)) warmBoardArtMemory([overlayUri]);
  }, [overlayUri]);
  return null;
});

type ClimbListThumbnailProps = {
  climbUuid?: string;
  readyBoardArtRef?: MutableRefObject<ReadyBoardArtSource | null>;
  frames: string;
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  mirrored?: boolean;
  /**
   * Override the list cell. The session feed hero passes a larger size
   * (84×104); ClimbListRow omits it and takes the list's cell
   * (`useClimbListThumbnailSize`: 76×96, or 88×112 in two columns). The
   * internal render width scales with `width` so the enlarged cell stays crisp.
   */
  size?: { width: number; height: number };
};

/**
 * Layered climb thumbnail for the list view. Wraps the shared
 * LayeredClimbImage stack in the list's portrait cell (override via `size`)
 * with rounded corners, using the filled hold style so the lit climb reads as
 * solid dots against the board photo at this small size.
 *
 * Mirror via CSS only — passing `mirrored` to the Rust renderer too
 * would double-flip, and we'd cache two PNGs per climb instead of one.
 * BoardImageNative (the play-view full-size renderer) follows the same
 * pattern.
 */
const ClimbListThumbnail = React.memo(function ClimbListThumbnail({
  climbUuid,
  readyBoardArtRef,
  frames,
  boardName,
  layoutId,
  sizeId,
  setIds,
  mirrored,
  size,
}: ClimbListThumbnailProps) {
  const { systemColors } = useTheme();
  const listCell = useClimbListThumbnailSize();
  const cell = size ?? listCell;
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
    artworkIdentity,
    getReadyBoardArtSnapshot,
  } = useNativeClimbRender({
    frames,
    boardName,
    layoutId,
    sizeId,
    setIds,
    filledStyle: true,
    renderWidth: size ? sizedThumbnailRenderWidth(size.width) : listThumbnailRenderWidth(listCell.width),
  });

  // Rendered when the row took this climb (a revisit, or a row the list warmed
  // ahead of the scroll) is not enough on its own: on a hard flick the row can
  // mount before the warm-up's decode has finished, and the view then shows the
  // bare board for the frames its own decode takes.
  const overlayPaintsWithBoard = overlayImmediate && isBoardArtInMemory(overlayUri);
  const displayIdentity = JSON.stringify([
    climbUuid,
    artworkIdentity,
    mirrored,
    overlayUri,
    overlayLoadKey,
    backgroundPaths,
  ]);
  const displayedRef = useRef<{ identity: string; loadKey: string | null }>({
    identity: displayIdentity,
    loadKey: null,
  });
  if (displayedRef.current.identity !== displayIdentity)
    displayedRef.current = { identity: displayIdentity, loadKey: null };
  if (readyBoardArtRef) {
    readyBoardArtRef.current = {
      read: () => {
        if (!climbUuid || displayedRef.current.identity !== displayIdentity) return undefined;
        return getReadyBoardArtSnapshot(climbUuid, mirrored ?? false, displayedRef.current.loadKey);
      },
    };
  }

  return (
    <View style={[styles.container, cell]}>
      <LayeredClimbImage
        overlayUri={overlayUri}
        overlayLoadKey={overlayLoadKey}
        displayIdentity={displayIdentity}
        onArtDisplayed={(loadKey) => {
          if (displayedRef.current.identity === displayIdentity) displayedRef.current.loadKey = loadKey;
        }}
        onOverlayLoad={onOverlayLoad}
        onOverlayError={onOverlayError}
        backgroundPaths={backgroundPaths}
        baseColor={backgroundBaseColor}
        missingBackgroundCount={missingBackgroundCount}
        mirrored={mirrored}
        recyclingKey={frames}
        // Rendered AND decoded: it is on the layer the frame the row mounts, so a
        // cross-fade from nothing would only put the bare board on screen.
        suppressOverlayTransition={overlayPaintsWithBoard}
        // Anything else — not rendered yet, or rendered but still to be decoded —
        // holds the whole thumbnail back until its holds have painted. Never for
        // an overlay that is not coming.
        revealWithOverlay={
          frames.length > 0 && !overlayPaintsWithBoard && !overlayUnavailable ? 'each-climb' : undefined
        }
        revealPlaceholderColor={systemColors.fill}
      />
    </View>
  );
});

export { ClimbListThumbnail };

const styles = StyleSheet.create({
  // Sized at the call site: the caller's `size`, or the list's cell.
  container: {
    borderRadius: borderRadius.md,
    overflow: 'hidden',
  },
});
