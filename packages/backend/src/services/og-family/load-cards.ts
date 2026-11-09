import { isValidFramesString } from '@boardsesh/board-render';
import { toFlatFrames, type BoardName } from '@boardsesh/board-constants';
import { OG_BOARD_BY_SLUG, OG_PLAYLIST_CLIMBS, OG_PLAYLIST_GATE, OG_SESSION_GATE } from './documents';
import { createAnonymousOgContext, runOgDocument } from './run-document';
import { PostGateCache } from './post-gate-cache';
import { readLatestSessionTickFrames } from './latest-session-tick';
import {
  PLAYLIST_ART_PAGE_SIZE,
  buildJoinCardContent,
  buildPlaylistArt,
  buildPlaylistCardContent,
  digestDrawnData,
  isRenderableConfig,
  namedBoardSlug,
  pickInviteName,
  resolveSessionBoard,
  type LoadedOgFamilyCard,
  type NamedBoardForCard,
  type PlaylistArtClimb,
  type PlaylistSummaryForCard,
  type SessionUserForCard,
} from './card-model';
import type { OgFamilyArtSpec } from '../board-render';

/** Ten minutes, the plan's figure: a list's first climbs rarely move. */
const PLAYLIST_CLIMBS_TTL_MS = 10 * 60_000;
/** A live session's newest tick moves every few minutes, so it gets a shorter memory. */
const SESSION_TICK_TTL_MS = 60_000;
const POST_GATE_MAX_ENTRIES = 256;

type PlaylistClimbsRead = { totalCount: number; climbs: PlaylistArtClimb[] };

const playlistClimbsCache = new PostGateCache<PlaylistClimbsRead>({
  ttlMs: PLAYLIST_CLIMBS_TTL_MS,
  maxEntries: POST_GATE_MAX_ENTRIES,
});
const sessionTickCache = new PostGateCache<string | null>({
  ttlMs: SESSION_TICK_TTL_MS,
  maxEntries: POST_GATE_MAX_ENTRIES,
});

/**
 * One load per card at a time. Facebook, Slack and WhatsApp each fetch a card
 * within the same moment; those land here, and share one gate and one render.
 * Nothing is kept once the load settles, so the next request runs its own gate.
 */
const cardLoadsInFlight = new Map<string, Promise<LoadedOgFamilyCard | null>>();

function coalesceCardLoad(
  key: string,
  load: () => Promise<LoadedOgFamilyCard | null>,
): Promise<LoadedOgFamilyCard | null> {
  const running = cardLoadsInFlight.get(key);
  if (running) return running;
  const started = load().finally(() => {
    cardLoadsInFlight.delete(key);
  });
  cardLoadsInFlight.set(key, started);
  return started;
}

/** Test seam: these are process-lifetime. */
export function resetOgFamilyLoadCaches(): void {
  playlistClimbsCache.clear();
  sessionTickCache.clear();
  cardLoadsInFlight.clear();
}

/**
 * Load a playlist card, or `null` for the 404. Gate first: a playlist that is
 * missing, private or `only_me` stops here, before any climb read or render.
 */
export function loadPlaylistCard(playlistId: string, fontFamily: string): Promise<LoadedOgFamilyCard | null> {
  return coalesceCardLoad(`playlist:${playlistId}`, async () => {
    const context = createAnonymousOgContext();
    const { playlist } = await runOgDocument<{
      playlist: {
        name: string;
        boardType: string;
        isPublic: boolean;
        gradeSummary: PlaylistSummaryForCard;
      } | null;
    }>(OG_PLAYLIST_GATE, { playlistId }, context);
    // `isPublic` on top of the resolver's own rule: `playlist` also answers for a
    // list shared with `public` audience while unlisted, and that is not a list to advertise.
    if (!playlist || !playlist.isPublic) return null;

    const { totalCount, climbs } = await playlistClimbsCache.read(playlistId, async () => {
      const { playlistClimbs } = await runOgDocument<{ playlistClimbs: PlaylistClimbsRead }>(
        OG_PLAYLIST_CLIMBS,
        { input: { playlistId, page: 0, pageSize: PLAYLIST_ART_PAGE_SIZE } },
        context,
      );
      return playlistClimbs;
    });

    const boardName = playlist.boardType as BoardName;
    const art = buildPlaylistArt(boardName, climbs);
    const content = buildPlaylistCardContent({
      name: playlist.name,
      boardName,
      climbCount: totalCount,
      summary: playlist.gradeSummary,
      art,
      fontFamily,
    });

    // The band is in `content` on purpose: its daily refresh does not touch
    // `playlists.updated_at`, and it is the biggest thing on the card.
    return { digest: digestDrawnData({ art, content }), art, content };
  });
}

/**
 * Load an invite card, or `null` for the 404. `session` returning null means the
 * session ended or is not anyone's to see: an invite for it could only lie.
 */
export function loadSessionJoinCard(sessionId: string, fontFamily: string): Promise<LoadedOgFamilyCard | null> {
  return coalesceCardLoad(`session:${sessionId}`, async () => {
    const context = createAnonymousOgContext();
    const { session } = await runOgDocument<{
      session: { boardPath: string; users: SessionUserForCard[] } | null;
    }>(OG_SESSION_GATE, { sessionId }, context);
    if (!session) return null;

    const slug = namedBoardSlug(session.boardPath);
    const namedBoard = slug
      ? (await runOgDocument<{ boardBySlug: NamedBoardForCard | null }>(OG_BOARD_BY_SLUG, { slug }, context))
          .boardBySlug
      : null;
    const board = resolveSessionBoard(session.boardPath, namedBoard);

    let art: OgFamilyArtSpec | null = null;
    if (board && isRenderableConfig(board.config)) {
      const { config } = board;
      const tickFrames = await sessionTickCache.read(`${sessionId}:${config.boardName}:${config.layoutId}`, () =>
        readLatestSessionTickFrames(sessionId, config),
      );
      const frames = toFlatFrames(tickFrames, config.boardName);
      art = { ...config, frames: isValidFramesString(frames) ? frames : '' };
    }

    const name = pickInviteName(session.users);
    const content = buildJoinCardContent({ name, board: art ? board : null, art, fontFamily });
    return { digest: digestDrawnData({ art, content }), art, content };
  });
}
