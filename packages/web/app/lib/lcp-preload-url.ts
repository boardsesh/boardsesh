import { getBoardImageDetailsForPlaylist, getBoardImageDetailsForBoard } from './board-image-details';
import type { BoardName } from '@/app/lib/types';
import type { SetIdList } from '@/app/lib/board-data';
import { getImageUrl } from '@/app/components/board-renderer/util';

/**
 * Compute the thumbnail URL for the first playlist's board image.
 * Used in server components to emit a `<link rel="preload">` for the LCP image.
 *
 * When `sizeId` + `setIds` are provided (board-scoped routes), the preload URL
 * is pinned to the user's exact board configuration so it matches what
 * `PlaylistPreviewSquare` will render. Without them (the global library page),
 * we fall back to the largest size for the layout.
 */
export function getPlaylistLcpPreloadUrl(
  playlist:
    | {
        boardType: string;
        layoutId?: number | null;
        sizeId?: number | null;
        setIds?: SetIdList | null;
      }
    | undefined
    | null,
): string | null {
  if (!playlist) return null;

  let boardDetails;
  if (playlist.layoutId != null && playlist.sizeId != null && playlist.setIds && playlist.setIds.length > 0) {
    try {
      boardDetails = getBoardImageDetailsForBoard({
        board_name: playlist.boardType as BoardName,
        layout_id: playlist.layoutId,
        size_id: playlist.sizeId,
        set_ids: playlist.setIds,
      });
    } catch {
      // Invalid combination — silently fall back to the largest-size lookup.
      boardDetails = getBoardImageDetailsForPlaylist(playlist.boardType, playlist.layoutId);
    }
  } else {
    boardDetails = getBoardImageDetailsForPlaylist(playlist.boardType, playlist.layoutId);
  }

  if (!boardDetails) return null;

  const firstImage = boardDetails.backgroundImagePaths[0];
  if (!firstImage) return null;

  return getImageUrl(firstImage, boardDetails.board_name, true);
}
