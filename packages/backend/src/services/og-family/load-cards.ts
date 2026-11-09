import { isValidFramesString } from '@boardsesh/board-render';
import type { BoardName } from '@boardsesh/board-constants';
import { OG_BOARD_BY_SLUG, OG_PLAYLIST_CLIMBS, OG_PLAYLIST_GATE, OG_SESSION_GATE, OG_SESSION_TICKS } from './documents';
import { createAnonymousOgContext, runOgDocument } from './run-document';
import {
  PLAYLIST_ART_PAGE_SIZE,
  buildJoinCardContent,
  buildPlaylistArt,
  buildPlaylistCardContent,
  digestDrawnData,
  isRenderableConfig,
  latestTickFrames,
  namedBoardSlug,
  pickInviteName,
  resolveSessionBoard,
  type LoadedOgFamilyCard,
  type NamedBoardForCard,
  type PlaylistArtClimb,
  type PlaylistSummaryForCard,
  type SessionTickForCard,
  type SessionUserForCard,
} from './card-model';
import type { OgFamilyArtSpec } from '../board-render';

/**
 * Load a playlist card, or `null` for the 404. Gate first: a playlist that is
 * missing, private or `only_me` stops here, before any climb read or render.
 */
export async function loadPlaylistCard(playlistId: string, fontFamily: string): Promise<LoadedOgFamilyCard | null> {
  const context = createAnonymousOgContext();
  const { playlist } = await runOgDocument<{
    playlist: {
      name: string;
      boardType: string;
      climbCount: number;
      isPublic: boolean;
      updatedAt: string;
      gradeSummary: PlaylistSummaryForCard;
    } | null;
  }>(OG_PLAYLIST_GATE, { playlistId }, context);
  if (!playlist || !playlist.isPublic) return null;

  const { playlistClimbs } = await runOgDocument<{ playlistClimbs: { climbs: PlaylistArtClimb[] } }>(
    OG_PLAYLIST_CLIMBS,
    { input: { playlistId, page: 0, pageSize: PLAYLIST_ART_PAGE_SIZE } },
    context,
  );

  const boardName = playlist.boardType as BoardName;
  const art = buildPlaylistArt(boardName, playlistClimbs.climbs);
  const content = buildPlaylistCardContent({
    name: playlist.name,
    boardName,
    climbCount: playlist.climbCount,
    summary: playlist.gradeSummary,
    art,
    fontFamily,
  });

  return {
    // `gradeSummary` is in here on purpose: its daily refresh does not touch
    // `playlists.updated_at`, and the band is the biggest thing on the card.
    digest: digestDrawnData({ playlistId, name: playlist.name, climbCount: playlist.climbCount, art, content }),
    art,
    content,
  };
}

/**
 * Load an invite card, or `null` for the 404. `session` returning null means the
 * session ended or is not anyone's to see: an invite for it could only lie.
 */
export async function loadSessionJoinCard(sessionId: string, fontFamily: string): Promise<LoadedOgFamilyCard | null> {
  const context = createAnonymousOgContext();
  const { session } = await runOgDocument<{
    session: { boardPath: string; users: SessionUserForCard[] } | null;
  }>(OG_SESSION_GATE, { sessionId }, context);
  if (!session) return null;

  const slug = namedBoardSlug(session.boardPath);
  const namedBoard = slug
    ? (await runOgDocument<{ boardBySlug: NamedBoardForCard | null }>(OG_BOARD_BY_SLUG, { slug }, context)).boardBySlug
    : null;
  const board = resolveSessionBoard(session.boardPath, namedBoard);

  let art: OgFamilyArtSpec | null = null;
  if (board && isRenderableConfig(board.config)) {
    const { sessionDetail } = await runOgDocument<{ sessionDetail: { ticks: SessionTickForCard[] } | null }>(
      OG_SESSION_TICKS,
      { sessionId },
      context,
    );
    const frames = latestTickFrames(sessionDetail?.ticks ?? [], board.config);
    art = { ...board.config, frames: isValidFramesString(frames) ? frames : '' };
  }

  const name = pickInviteName(session.users);
  const content = buildJoinCardContent({ name, board: art ? board : null, art, fontFamily });
  return {
    digest: digestDrawnData({ sessionId, art, content }),
    art,
    content,
  };
}
