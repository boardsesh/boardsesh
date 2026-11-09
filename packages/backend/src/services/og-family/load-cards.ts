import { isValidFramesString } from '@boardsesh/board-render';
import { toFlatFrames, type BoardName } from '@boardsesh/board-constants';
import {
  OG_BOARD_BY_SLUG,
  OG_PLAYLIST_CLIMBS,
  OG_PLAYLIST_GATE,
  OG_PROFILE_GATE,
  OG_PROFILE_HARDEST_SEND,
  OG_PROFILE_STATS,
  OG_SESSION_GATE,
  OG_SETTER_GATE,
  OG_SETTER_TOP_CLIMB,
  OG_SETTER_TOTAL_ASCENTS,
} from './documents';
import { createAnonymousOgContext, runOgDocument } from './run-document';
import { PostGateCache } from './post-gate-cache';
import { readLatestSessionTickFrames } from './latest-session-tick';
import { canViewSessionRecap, readSessionRecap, type SessionRecapRead } from './session-recap';
import { loadCardAvatar, resetAvatarCache } from './load-avatar';
import {
  PLAYLIST_ART_PAGE_SIZE,
  buildClimbArt,
  buildJoinCardContent,
  buildPlaylistArt,
  buildPlaylistCardContent,
  buildProfileCardContent,
  buildRecapCardContent,
  buildSetterArt,
  buildSetterCardContent,
  digestCard,
  digestDrawnData,
  isRenderableConfig,
  namedBoardSlug,
  pickInviteName,
  resolveSessionBoard,
  type HardestSendForCard,
  type LoadedOgFamilyCard,
  type NamedBoardForCard,
  type PlaylistArtClimb,
  type PlaylistSummaryForCard,
  type ProfileStatsForCard,
  type SessionUserForCard,
  type SetterTopClimbForCard,
} from './card-model';
import type { OgFamilyArtSpec } from '../board-render';

/** Ten minutes, the plan's figure: a list's first climbs rarely move. */
const PLAYLIST_CLIMBS_TTL_MS = 10 * 60_000;
/** A live session's newest tick moves every few minutes, so it gets a shorter memory. */
const SESSION_TICK_TTL_MS = 60_000;
const POST_GATE_MAX_ENTRIES = 256;
/** The plan's figure for reads that are expensive and change slowly. */
const EXPENSIVE_READ_TTL_MS = 10 * 60_000;
/**
 * The hardest send names a specific climb and tick, unlike the totals, so a
 * revoked tick should leave the card quickly. Still long enough to absorb one
 * crawl's burst.
 */
const HARDEST_SEND_TTL_MS = 60_000;

type PlaylistClimbsRead = { totalCount: number; climbs: PlaylistArtClimb[] };

const playlistClimbsCache = new PostGateCache<PlaylistClimbsRead>({
  ttlMs: PLAYLIST_CLIMBS_TTL_MS,
  maxEntries: POST_GATE_MAX_ENTRIES,
});
const sessionTickCache = new PostGateCache<string | null>({
  ttlMs: SESSION_TICK_TTL_MS,
  maxEntries: POST_GATE_MAX_ENTRIES,
});
const profileStatsCache = new PostGateCache<ProfileStatsForCard>({
  ttlMs: EXPENSIVE_READ_TTL_MS,
  maxEntries: POST_GATE_MAX_ENTRIES,
});
const hardestSendCache = new PostGateCache<HardestSendForCard | null>({
  ttlMs: HARDEST_SEND_TTL_MS,
  maxEntries: POST_GATE_MAX_ENTRIES,
});
const setterTotalCache = new PostGateCache<number>({
  ttlMs: EXPENSIVE_READ_TTL_MS,
  maxEntries: POST_GATE_MAX_ENTRIES,
});
const setterTopClimbCache = new PostGateCache<SetterTopClimbForCard | null>({
  ttlMs: EXPENSIVE_READ_TTL_MS,
  maxEntries: POST_GATE_MAX_ENTRIES,
});
const sessionRecapCache = new PostGateCache<SessionRecapRead | null>({
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
  profileStatsCache.clear();
  hardestSendCache.clear();
  setterTotalCache.clear();
  setterTopClimbCache.clear();
  sessionRecapCache.clear();
  cardLoadsInFlight.clear();
  resetAvatarCache();
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

/** A climber with no sends still gets a wall behind the name: a 12x12 Kilter, unlit. */
const EMPTY_PROFILE_BOARD = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', frames: '' } as const;

function unlitDefaultBoard(): OgFamilyArtSpec | null {
  return isRenderableConfig(EMPTY_PROFILE_BOARD) ? EMPTY_PROFILE_BOARD : null;
}

/**
 * Load a profile card, or `null` for the 404. A private account stops at the first
 * read, before stats, frames, avatars or a render.
 */
export function loadProfileCard(userId: string, fontFamily: string): Promise<LoadedOgFamilyCard | null> {
  return coalesceCardLoad(`profile:${userId}`, async () => {
    const context = createAnonymousOgContext();
    const { publicProfile } = await runOgDocument<{
      publicProfile: { displayName: string | null; avatarUrl: string | null; isPrivate: boolean } | null;
    }>(OG_PROFILE_GATE, { userId }, context);
    if (!publicProfile || publicProfile.isPrivate) return null;

    const [stats, hardest, avatar] = await Promise.all([
      profileStatsCache.read(userId, async () => {
        const { userProfileStats } = await runOgDocument<{ userProfileStats: ProfileStatsForCard }>(
          OG_PROFILE_STATS,
          { userId },
          context,
        );
        return userProfileStats;
      }),
      hardestSendCache.read(userId, async () => {
        const { userAscentsFeed } = await runOgDocument<{ userAscentsFeed: { items: HardestSendForCard[] } }>(
          OG_PROFILE_HARDEST_SEND,
          { userId, input: { limit: 1, sortBy: 'hardest', statusMode: 'send' } },
          context,
        );
        return userAscentsFeed.items[0] ?? null;
      }),
      loadCardAvatar(publicProfile.avatarUrl),
    ]);

    const art = hardest ? buildClimbArt(hardest.boardType, hardest.frames, hardest.renderBoard) : unlitDefaultBoard();
    const content = buildProfileCardContent({
      displayName: publicProfile.displayName,
      avatar,
      hardest,
      stats,
      art,
      fontFamily,
    });
    return { digest: digestCard(art, content), art, content };
  });
}

/**
 * Load a setter card, or `null` for the 404. The total and top climb are read
 * through `SetterProfile.totalAscents` and `setterClimbsFull`, whose listable
 * conditions keep drafts, hidden climbs and private walls out of both.
 */
export function loadSetterCard(username: string, fontFamily: string): Promise<LoadedOgFamilyCard | null> {
  return coalesceCardLoad(`setter:${username}`, async () => {
    const context = createAnonymousOgContext();
    const input = { username };
    const { setterProfile } = await runOgDocument<{
      setterProfile: {
        climbCount: number;
        boardTypes: string[];
        linkedUserDisplayName: string | null;
        linkedUserAvatarUrl: string | null;
      } | null;
    }>(OG_SETTER_GATE, { input }, context);
    if (!setterProfile) return null;

    const [totalAscents, topClimb, avatar] = await Promise.all([
      setterTotalCache.read(username, async () => {
        const result = await runOgDocument<{ setterProfile: { totalAscents: number } | null }>(
          OG_SETTER_TOTAL_ASCENTS,
          { input },
          context,
        );
        return result.setterProfile?.totalAscents ?? 0;
      }),
      setterTopClimbCache.read(username, async () => {
        const { setterClimbsFull } = await runOgDocument<{ setterClimbsFull: { climbs: SetterTopClimbForCard[] } }>(
          OG_SETTER_TOP_CLIMB,
          { input: { username, sortBy: 'popular', limit: 1 } },
          context,
        );
        return setterClimbsFull.climbs[0] ?? null;
      }),
      loadCardAvatar(setterProfile.linkedUserAvatarUrl),
    ]);

    const art = buildSetterArt(topClimb);
    const content = buildSetterCardContent({
      username,
      linkedDisplayName: setterProfile.linkedUserDisplayName,
      avatar,
      hasLinkedAvatar: !!setterProfile.linkedUserAvatarUrl,
      climbCount: setterProfile.climbCount,
      boardTypes: setterProfile.boardTypes,
      totalAscents,
      topClimb,
      art,
      fontFamily,
    });
    return { digest: digestCard(art, content), art, content };
  });
}

/**
 * Load a recap card, or `null` for the 404. Access is checked on every request;
 * only the tick rollup behind it is remembered.
 */
export function loadSessionRecapCard(sessionId: string, fontFamily: string): Promise<LoadedOgFamilyCard | null> {
  return coalesceCardLoad(`session-recap:${sessionId}`, async () => {
    if (!(await canViewSessionRecap(sessionId))) return null;
    const recap = await sessionRecapCache.read(sessionId, () => readSessionRecap(sessionId));
    if (!recap) return null;
    const featured = recap.featured;
    const art = featured ? buildClimbArt(featured.boardType, featured.frames, featured.renderBoard) : null;
    const content = buildRecapCardContent({ recap, art, fontFamily });
    return { digest: digestCard(art, content), art, content };
  });
}
