import { useMemo } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import type { BoardName } from '@boardsesh/shared-schema';
import { getBoardRenderData } from '../../lib/board-details';
import { type BoardConfig } from '../../providers/drawer-host-provider';
import { BoardImageNative } from '../BoardImageNative';

/** Square slot size for the accessory-bar board thumbnail. */
export const ACCESSORY_THUMBNAIL_SLOT_SIZE = 40;
const ACCESSORY_THUMBNAIL_ART_MAX_SIZE = 40;
const ACCESSORY_THUMBNAIL_ART_RADIUS = 10;

type AccessoryThumbnailClimb = {
  frames: string;
  mirrored?: boolean | null;
};

function getAccessoryThumbnailBoardSize(boardWidth: number, boardHeight: number, maxSize: number) {
  const boardAspectRatio = boardWidth / boardHeight;
  if (!Number.isFinite(boardAspectRatio) || boardAspectRatio <= 0) {
    return { width: maxSize, height: maxSize };
  }
  if (boardAspectRatio >= 1) {
    return { width: maxSize, height: maxSize / boardAspectRatio };
  }
  return { width: maxSize * boardAspectRatio, height: maxSize };
}

/**
 * The small board render shown beside the climb name in the accessory bar (the
 * floating capsule and the iOS 26 native accessory). Renders nothing if the
 * board config or render data isn't available.
 *
 * Uses the rasterized native-PNG path (BoardImageNative -> useNativeClimbRender
 * + LayeredClimbImage, `cachePolicy="memory-disk"` over bundled `file://`
 * backgrounds) — the same warm path the list thumbnails use. The accessory bar
 * is always mounted and re-renders on every queue swipe, so the cheap cached-PNG
 * path matters here.
 *
 * Renders with `filledStyle` and the same `renderWidth` as the list thumbnail so
 * lit holds read as solid dots at the 40×40 slot size. Matching both means the
 * cache key matches the list view's (same filled `_f_` and `_w400_` tokens), so a
 * climb already seen in the list is an instant cache hit. The play-view full-size
 * render uses the stroke-only style (`_s_`) at native width (`_wfull_`) and caches
 * as a separate PNG. See docs/react-native-performance.md §6.
 */
export function AccessoryClimbThumbnail({
  climb,
  boardConfig,
  size = ACCESSORY_THUMBNAIL_SLOT_SIZE,
}: {
  climb: AccessoryThumbnailClimb;
  boardConfig: BoardConfig | null;
  size?: number;
}) {
  const boardRenderData = useMemo(() => {
    if (!boardConfig) return null;
    const setIdValues = boardConfig.setIds
      .split(',')
      .map((setIdText) => Number(setIdText))
      .filter((setIdValue) => Number.isFinite(setIdValue));
    if (setIdValues.length === 0) return null;
    return getBoardRenderData({
      boardName: boardConfig.boardName as BoardName,
      layoutId: boardConfig.layoutId,
      sizeId: boardConfig.sizeId,
      setIds: setIdValues,
    });
  }, [boardConfig]);

  if (!boardRenderData || !boardConfig) return null;

  // Fit the board art into the 40×40 slot at its native aspect ratio, then
  // hand BoardImageNative an explicitly-sized, rounded, clipped box. (Its
  // default `width: '100%'` would otherwise stretch the art across the slot.)
  const fittedSize = getAccessoryThumbnailBoardSize(boardRenderData.boardWidth, boardRenderData.boardHeight, size);
  const radius = ACCESSORY_THUMBNAIL_ART_RADIUS * (size / ACCESSORY_THUMBNAIL_ART_MAX_SIZE);
  const thumbnailBoardStyle: ViewStyle = {
    width: fittedSize.width,
    height: fittedSize.height,
    borderRadius: radius,
    overflow: 'hidden',
  };

  return (
    <View style={[styles.thumbnailSlot, { width: size, height: size }]}>
      <BoardImageNative
        frames={climb.frames}
        boardName={boardConfig.boardName as BoardName}
        layoutId={boardConfig.layoutId}
        sizeId={boardConfig.sizeId}
        setIds={boardConfig.setIds}
        boardWidth={boardRenderData.boardWidth}
        boardHeight={boardRenderData.boardHeight}
        mirrored={climb.mirrored === true}
        filledStyle
        renderWidth={400}
        style={thumbnailBoardStyle}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  thumbnailSlot: {
    width: ACCESSORY_THUMBNAIL_SLOT_SIZE,
    height: ACCESSORY_THUMBNAIL_SLOT_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
});
