import { memo, useCallback, useMemo, useState, type ReactNode } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { formatBoardDisplayName, toBoardName } from '@boardsesh/board-config';
import { BoardImageNative } from '../BoardImageNative';
import { Icon } from '../Icon';
import { ART_SLOTS, type ArtSize } from '../art-slot';
import { useTheme } from '../../providers/theme-provider';
import { getBoardRenderData } from '../../lib/board-details';
import { parseSetIds } from '../../lib/board-presence/parse-set-ids';
import { useSprayWallToken } from '../../lib/spray/use-spray-wall-token';
import { useSprayPhotoOnDisk } from '../../lib/spray/use-spray-photo-on-disk';
import { useSprayWallThumbnail } from '../../lib/spray/use-spray-wall-thumbnail';
import type { BoardArtReadiness } from '../../lib/board-render/ready-board-art';
import { borderRadius } from '../../theme/tokens';

/** An art slot (`compact` 36×44, `regular` 44×56), or the side of a square slot in points. */
export type BoardThumbnailSize = ArtSize | number;

/** The board fields a thumbnail needs: a structural subset of the active board and of a board row. */
export type BoardThumbnailBoard = {
  uuid?: string;
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  sprayImport?: { versionId: string | null } | null;
};

/** What the slot shows when there is no art: a camera for a spray wall, the boards glyph otherwise. */
export type BoardThumbnailPlaceholder = 'camera' | 'boards';

type Slot = { width: number; height: number };

/** 22pt in the row slots, growing to 28pt in a big square. */
function placeholderGlyphSize(slot: Slot): number {
  return Math.min(28, Math.max(22, Math.round(Math.min(slot.width, slot.height) * 0.4)));
}

/** A small slot takes the small corner, so the radius stays in proportion. */
function cornerFor(slot: Slot) {
  return { borderRadius: slot.width >= 64 ? borderRadius.md : borderRadius.sm, borderCurve: 'continuous' } as const;
}

export type BoardThumbnailViewProps = {
  size: BoardThumbnailSize;
  /** The board's width over its height, or null when there is no art to draw. */
  aspectRatio: number | null;
  placeholder: BoardThumbnailPlaceholder;
  /** The board art, drawn to fill a box of `aspectRatio` fitted inside the slot. */
  art: ReactNode;
  /** Defaults to true: a thumbnail beside the board's name says nothing new. */
  accessibilityHidden?: boolean;
  accessibilityLabel?: string;
};

/**
 * The thumbnail without the catalogue: the slot, the art box and the
 * placeholder. Stories pass their own art; the app uses `BoardThumbnail`.
 */
export const BoardThumbnailView = memo(function BoardThumbnailView({
  size,
  aspectRatio,
  placeholder,
  art,
  accessibilityHidden = true,
  accessibilityLabel,
}: BoardThumbnailViewProps) {
  const { systemColors } = useTheme();
  const slotWidth = typeof size === 'number' ? size : ART_SLOTS[size].width;
  const slotHeight = typeof size === 'number' ? size : ART_SLOTS[size].height;
  const slotStyle = useMemo(() => ({ width: slotWidth, height: slotHeight }), [slotWidth, slotHeight]);
  const corner = useMemo(() => cornerFor(slotStyle), [slotStyle]);
  // Fit the board inside the slot at its own aspect ratio: a MoonBoard stays a
  // tall strip and a wide board a short one, with nothing painted around it.
  const artBoxStyle = useMemo(() => {
    if (aspectRatio === null || !(aspectRatio > 0)) return null;
    // Each side clamped on its own, so the side that fills the slot is exact.
    const width = Math.min(slotWidth, slotHeight * aspectRatio);
    const height = Math.min(slotHeight, slotWidth / aspectRatio);
    return { width, height, ...corner };
  }, [aspectRatio, slotWidth, slotHeight, corner]);
  const borderStyle = useMemo(
    () => [styles.hairline, corner, { borderColor: systemColors.separator }],
    [corner, systemColors.separator],
  );
  const hiddenProps = accessibilityHidden
    ? ({
        accessible: false,
        accessibilityElementsHidden: true,
        importantForAccessibility: 'no-hide-descendants',
      } as const)
    : ({ accessible: true, accessibilityRole: 'image', accessibilityLabel } as const);

  return (
    <View pointerEvents="none" style={[styles.slot, slotStyle]} {...hiddenProps}>
      {artBoxStyle && art ? (
        <View style={[styles.artBox, artBoxStyle]}>
          {art}
          {/* The hairline sits on the art itself, drawn over it so it costs the art no pixels. */}
          <View style={[StyleSheet.absoluteFill, borderStyle]} />
        </View>
      ) : (
        <View style={[styles.placeholder, slotStyle, borderStyle]}>
          <Icon name={placeholder} size={placeholderGlyphSize(slotStyle)} color={systemColors.tertiaryLabel} />
        </View>
      )}
    </View>
  );
});

export type BoardThumbnailProps = {
  board: BoardThumbnailBoard;
  size: BoardThumbnailSize;
  /** Defaults to true. When false, VoiceOver reads it as an image of the board type. */
  accessibilityHidden?: boolean;
  /** Forwarded to the board renderer, for a capture that waits on painted art. */
  onArtReadinessChange?: (readiness: BoardArtReadiness) => void;
};

const FILL_ART_BOX = { width: '100%', height: '100%' } as const;

/**
 * A board's bare art (no climb lit) in an art slot, for a row or a card.
 *
 * The art keeps its own aspect ratio inside the slot, with a hairline on the art
 * and no grey tile behind it. A board the catalogue can't draw shows the boards
 * glyph in an empty hairline slot. A spray wall shows its cached photo, and the
 * camera glyph until the photo is on disk.
 *
 * Renders at 400px wide whatever the slot, so it shares the bundled thumbnail
 * and the native raster cache with board discovery.
 */
export const BoardThumbnail = memo(function BoardThumbnail({ board, ...props }: BoardThumbnailProps) {
  if (board.boardType === 'spray' && board.uuid) {
    return <SprayPhotoThumbnail {...props} board={board} wallUuid={board.uuid} />;
  }
  return <RenderedBoardThumbnail {...props} board={board} />;
});

/** A saved wall carries its UUID; its preview needs only the authorized photo. */
function SprayPhotoThumbnail({
  board,
  wallUuid,
  size,
  accessibilityHidden = true,
  onArtReadinessChange,
}: BoardThumbnailProps & { wallUuid: string }) {
  const preview = useSprayWallThumbnail({
    wallUuid,
    layoutId: board.layoutId,
    draftVersionId: board.sprayImport?.versionId ?? null,
  });
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const uri = preview?.uri ?? null;
  const source = useMemo(() => (uri ? { uri } : undefined), [uri]);
  const onLoad = useCallback(() => onArtReadinessChange?.('ready'), [onArtReadinessChange]);
  const onError = useCallback(() => {
    setFailedUri(uri);
    onArtReadinessChange?.('failed');
  }, [uri, onArtReadinessChange]);
  const drawable = preview !== null && uri !== failedUri;

  return (
    <BoardThumbnailView
      size={size}
      aspectRatio={drawable ? preview.aspectRatio : null}
      placeholder="camera"
      accessibilityHidden={accessibilityHidden}
      accessibilityLabel={formatBoardDisplayName(board.boardType)}
      art={
        drawable ? (
          <Image source={source} resizeMode="contain" style={FILL_ART_BOX} onLoad={onLoad} onError={onError} />
        ) : null
      }
    />
  );
}

/** Catalogue art and config-only callers retain the shared board renderer. */
const RenderedBoardThumbnail = memo(function RenderedBoardThumbnail({
  board,
  size,
  accessibilityHidden = true,
  onArtReadinessChange,
}: BoardThumbnailProps) {
  const { boardType, layoutId, sizeId, setIds } = board;
  const boardName = toBoardName(boardType);
  // Spray walls can arrive or reset after the saved board has been restored.
  const sprayToken = useSprayWallToken(boardName, layoutId);
  const renderData = useMemo(() => {
    if (!boardName) return null;
    const setIdValues = parseSetIds(setIds);
    if (setIdValues.length === 0) return null;
    return getBoardRenderData({ boardName, layoutId, sizeId, setIds: setIdValues });
    // `sprayToken` recomputes this when the wall lands or is reset.
  }, [boardName, layoutId, sizeId, setIds, sprayToken]);
  const isSprayWall = boardName === 'spray';
  const sprayPhotoOnDisk = useSprayPhotoOnDisk(isSprayWall ? renderData : null);
  const drawable = renderData !== null && boardName !== null && (!isSprayWall || sprayPhotoOnDisk);

  return (
    <BoardThumbnailView
      size={size}
      aspectRatio={drawable ? renderData.boardWidth / renderData.boardHeight : null}
      placeholder={isSprayWall ? 'camera' : 'boards'}
      accessibilityHidden={accessibilityHidden}
      accessibilityLabel={formatBoardDisplayName(boardType)}
      art={
        drawable ? (
          <BoardImageNative
            frames=""
            boardName={boardName}
            layoutId={layoutId}
            sizeId={sizeId}
            setIds={setIds}
            boardWidth={renderData.boardWidth}
            boardHeight={renderData.boardHeight}
            // Share the bundled thumbnail and native raster cache with board discovery.
            renderWidth={400}
            style={FILL_ART_BOX}
            onArtReadinessChange={onArtReadinessChange}
          />
        ) : null
      }
    />
  );
});

const styles = StyleSheet.create({
  slot: {
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  artBox: {
    overflow: 'hidden',
  },
  hairline: {
    borderWidth: StyleSheet.hairlineWidth,
  },
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
