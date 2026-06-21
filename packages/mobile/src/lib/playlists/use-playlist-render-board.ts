// Decides which board a playlist-detail screen should prefer for climb-row
// rendering, and whether to show a board-switch prompt.
//
// Playlists carry only `boardType` + `layoutId`. When the active board matches,
// rows render against the user's precise board (correct size/sets/angle) and
// tapping queues normally. When it differs, rows still receive the active board
// first; each row can then fall back to its own board and visually mark itself
// incompatible. If there is no active board, we fall back to the playlist's own
// board (largest size + all sets, via `getBoardConfigForPlaylist`) so the list
// can still render.

import { useMemo } from 'react';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { formatBoardDisplayName } from '@boardsesh/board-config';
import type { BoardConfig } from '../../providers/drawer-host-provider';
import { boardLooselyMatches } from '../boards/board-matches';
import { useActiveBoard } from '../graphql/use-active-board';
import { getBoardConfigForPlaylist } from './board-details-for-playlist';

/** The board a playlist's rows render against — same shape as the active board
 *  config; `setIds` is the comma-joined string `ClimbListRow` expects. */
export type PlaylistRenderBoard = BoardConfig;

/** Shown above a playlist list when its board differs from the active board (or
 *  there is no active board). Strings are already translated. */
export type PlaylistBoardBanner = {
  title: string;
  subtitle: string;
  cta: string;
  onPress: () => void;
};

export type UsePlaylistRenderBoardResult = {
  /** Preferred board for climb rows, or null when no active/fallback board can
   *  be resolved. Individual rows may choose a different board to render a
   *  specific climb. */
  renderBoard: PlaylistRenderBoard | null;
  /** Set when the board-switch banner should be shown. */
  banner: PlaylistBoardBanner | null;
};

/**
 * Resolve the render board + optional mismatch banner for a playlist-detail
 * screen. Pass the playlist's `{ boardType, layoutId }`, or `null` for smart
 * playlists (they're computed relative to the active board, so they always
 * render against it with no mismatch banner).
 */
export function usePlaylistRenderBoard(
  playlistBoard: { boardType: string; layoutId?: number | null } | null,
): UsePlaylistRenderBoardResult {
  const activeBoard = useActiveBoard().data ?? null;
  const router = useRouter();
  const { t } = useTranslation('playlists');

  // Read the primitives up front so the memos stay stable across the fresh
  // `playlistBoard` object callers pass inline each render.
  const boardType = playlistBoard?.boardType ?? null;
  const layoutId = playlistBoard?.layoutId ?? null;

  const activeRenderBoard = useMemo<PlaylistRenderBoard | null>(() => {
    if (!activeBoard) return null;
    return {
      boardName: activeBoard.boardType,
      layoutId: activeBoard.layoutId,
      sizeId: activeBoard.sizeId,
      setIds: activeBoard.setIds,
      angle: activeBoard.angle,
    };
  }, [activeBoard]);

  // Resolve the preferred render board + mismatch flag from the real board state only (no
  // `t`/`router`), so `renderBoard`'s identity is stable across unrelated
  // re-renders and never churns the FlashList rows that depend on it.
  const { renderBoard, mismatch } = useMemo<{ renderBoard: PlaylistRenderBoard | null; mismatch: boolean }>(() => {
    // Smart playlists (no board): always the active board, no mismatch concept.
    if (boardType == null) return { renderBoard: activeRenderBoard, mismatch: false };

    const matchesActive = boardLooselyMatches({ boardName: boardType, layoutId }, activeRenderBoard);
    if (matchesActive) return { renderBoard: activeRenderBoard, mismatch: false };

    // Mismatch with an active board: keep passing the active board into row
    // rendering so each row can decide whether it fits, or fall back to its own
    // board and mark itself incompatible.
    if (activeRenderBoard) return { renderBoard: activeRenderBoard, mismatch: true };

    // No active board → render against the playlist's own board (largest size +
    // all sets). `null` when it can't resolve (e.g. MoonBoard), in which case
    // the banner shows alone rather than a half-broken list.
    const resolved = getBoardConfigForPlaylist(boardType, layoutId);
    if (!resolved) return { renderBoard: null, mismatch: true };
    return {
      renderBoard: {
        boardName: resolved.boardName,
        layoutId: resolved.layoutId,
        sizeId: resolved.sizeId,
        setIds: resolved.setIds.join(','),
        // List-level angle is unused in the no-active-board fallback — each row
        // renders at its own climb's angle (the angle its grade was baked at).
        angle: 0,
      },
      mismatch: true,
    };
  }, [activeRenderBoard, boardType, layoutId]);

  // Banner copy + navigation depend on `t`/`router`; kept in a separate memo so
  // their (possible) identity churn can't recreate `renderBoard`.
  const banner = useMemo<PlaylistBoardBanner | null>(() => {
    if (!mismatch || boardType == null) return null;
    const boardLabel = formatBoardDisplayName(boardType);
    return {
      title: t('detail.boardMismatch.title', { board: boardLabel }),
      subtitle: t('detail.boardMismatch.subtitle', { board: boardLabel }),
      cta: t('detail.boardMismatch.cta'),
      onPress: () => router.push({ pathname: '/boards', params: { returnTo: '/(tabs)/discover' } }),
    };
  }, [mismatch, boardType, t, router]);

  return { renderBoard, banner };
}
