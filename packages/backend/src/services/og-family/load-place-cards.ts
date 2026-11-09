import { isValidFramesString } from '@boardsesh/board-render';
import { toFlatFrames, type BoardName } from '@boardsesh/board-constants';
import type { OgFamilyArtSpec, OgFamilyPhotoArt } from '../board-render';
import {
  createSprayOgCardDeps,
  type SprayOgCardDeps,
  type SprayOgVersionRow,
  type SprayOgWallRow,
} from '../spray-og-card';
import { canAccessResourceWithoutLink } from '../privacy';
import { isRenderableConfig, type BoardConfig, type LoadedOgFamilyCard } from './card-model';
import { runCardRead } from './card-read-limit';
import { coalesceCardLoad } from './coalesce-card-load';
import { OG_PLACE_BOARD, OG_PLACE_GYM, OG_PLACE_TOP_CLIMB } from './documents';
import {
  buildBoardCardContent,
  buildGymCardContent,
  buildSprayCardContent,
  digestPlaceCard,
  pickGymBoardConfig,
  type BoardForCard,
  type GymForCard,
} from './place-card-model';
import { loadGymPhoto, renderSprayWallPhoto, resetPlacePhotoCache } from './place-photo';
import { PostGateCache } from './post-gate-cache';
import { createAnonymousOgContext, runOgDocument } from './run-document';

/**
 * Picks are held for at most 60 s: a climb the community hides or a setter pulls
 * has to leave the card quickly, and a place's cards are re-gated on every request.
 */
const TOP_CLIMB_TTL_MS = 60_000;
const SPRAY_ART_TTL_MS = 60_000;
const POST_GATE_MAX_ENTRIES = 256;
const SPRAY_ART_CACHE_ENTRIES = 24;

const topClimbFramesCache = new PostGateCache<string | null>({
  ttlMs: TOP_CLIMB_TTL_MS,
  maxEntries: POST_GATE_MAX_ENTRIES,
});

type SprayPlaceArt = { photo: OgFamilyPhotoArt; holdCount: number };

const sprayArtCache = new PostGateCache<SprayPlaceArt | null>({
  ttlMs: SPRAY_ART_TTL_MS,
  maxEntries: SPRAY_ART_CACHE_ENTRIES,
});

/** Test seam: these are process-lifetime. */
export function resetOgFamilyPlaceCaches(): void {
  topClimbFramesCache.clear();
  sprayArtCache.clear();
  resetPlacePhotoCache();
}

/**
 * The most-climbed listable climb on this config, read through `searchClimbs` so
 * it carries the same filters every browse list has: no drafts, nothing unlisted,
 * no community-hidden climb, and only climbs that fit this size and these sets.
 */
function readTopClimbFrames(
  config: BoardConfig,
  angle: number,
  options: { intactHoldsOnly?: boolean } = {},
): Promise<string | null> {
  const { boardName, layoutId, sizeId, setIds } = config;
  const key = `${boardName}:${layoutId}:${sizeId}:${setIds}:${angle}`;
  return topClimbFramesCache.read(key, () =>
    runCardRead(async () => {
      const { searchClimbs } = await runOgDocument<{ searchClimbs: { climbs: { frames: string | null }[] } }>(
        OG_PLACE_TOP_CLIMB,
        {
          input: {
            boardName,
            layoutId,
            sizeId,
            setIds,
            angle,
            page: 0,
            pageSize: 1,
            sortBy: 'ascents',
            sortOrder: 'desc',
            ...(options.intactHoldsOnly ? { holdIntegrity: 'INTACT' } : {}),
          },
        },
        createAnonymousOgContext(),
      );
      return searchClimbs.climbs[0]?.frames ?? null;
    }),
  );
}

/** A board's art: one real climb, or the unlit board when nothing fits it. */
async function buildBoardArt(config: BoardConfig, angle: number): Promise<OgFamilyArtSpec> {
  const frames = toFlatFrames(await readTopClimbFrames(config, angle), config.boardName);
  return { ...config, frames: isValidFramesString(frames) ? frames : '' };
}

/**
 * Load a gym card, or `null` for the 404. `gymBySlug` is the gate: a private or
 * missing gym stops here, before any photo or climb read. Its board lines come
 * from the same read: `gymBoards` would spend a rate-limit bucket to answer
 * less, since an anonymous caller only sees public boards there.
 */
export function loadGymPlaceCard(slug: string, fontFamily: string): Promise<LoadedOgFamilyCard | null> {
  return coalesceCardLoad(`place-gym:${slug}`, async () => {
    const context = createAnonymousOgContext();
    const { gymBySlug: gym } = await runOgDocument<{ gymBySlug: GymForCard | null }>(OG_PLACE_GYM, { slug }, context);
    if (!gym) return null;

    const photo = await loadGymPhoto(gym.imageUrl, runCardRead);
    let art: OgFamilyArtSpec | null = null;
    if (!photo) {
      const choice = pickGymBoardConfig(gym.boardTypes, gym.boardSummaries);
      if (choice) art = await buildBoardArt(choice.config, choice.angle);
    }

    const content = buildGymCardContent({ gym, hasArt: !!photo || !!art, fontFamily });
    return { digest: digestPlaceCard(art, photo, content), art, photo, content };
  });
}

export type SprayCardGateResult = { wall: SprayOgWallRow; version: SprayOgVersionRow; photoUrl: string };

/**
 * The checks `renderSprayOgCard` runs, in its order, every one before any photo
 * byte can be read: gone, not public, hidden, never published, no public copy.
 * `boardBySlug` has already applied the wall's own visibility rule; this re-reads
 * the state a card draws on, so a row the resolver passed moments ago that has
 * since lost its photo still answers the one 404.
 */
export async function passSprayCardGates(
  layoutId: number,
  deps: Pick<SprayOgCardDeps, 'loadWall' | 'loadPublishedVersion' | 'publicPhotoUrl'>,
): Promise<SprayCardGateResult | null> {
  const wall = await deps.loadWall(layoutId);
  if (!wall) return null;
  if (wall.isPublic !== true) return null;
  if (wall.hiddenAt !== null) return null;
  if (wall.currentVersionId === null) return null;
  if (wall.publicPhotoKey === null) return null;
  const photoUrl = deps.publicPhotoUrl(wall.publicPhotoKey);
  if (photoUrl === null) return null;
  const version = await deps.loadPublishedVersion(wall.wallId);
  if (!version) return null;
  return { wall, version, photoUrl };
}

const sprayDeps = createSprayOgCardDeps();

async function loadSprayPlaceCard(board: BoardForCard, fontFamily: string): Promise<LoadedOgFamilyCard | null> {
  const gate = await passSprayCardGates(board.layoutId, sprayDeps);
  if (!gate) return null;
  const { wall, version, photoUrl } = gate;

  const config: BoardConfig = {
    boardName: 'spray',
    layoutId: wall.layoutId,
    sizeId: board.sizeId,
    setIds: board.setIds,
  };
  const frames = (await readTopClimbFrames(config, board.angle, { intactHoldsOnly: true })) ?? '';

  const sprayArt = await sprayArtCache.read(
    `${wall.wallId}:${wall.currentVersionId}:${wall.publicPhotoKey}:${frames}`,
    () =>
      runCardRead(async () => {
        const holds = await sprayDeps.loadAliveHolds(wall.wallId);
        const photo = await renderSprayWallPhoto({ photoUrl, version, holds, frames });
        return photo ? { photo, holdCount: holds.length } : null;
      }),
  );
  if (!sprayArt) return null;

  const { photo, holdCount } = sprayArt;
  const content = buildSprayCardContent({ board, holdCount, fontFamily });
  return { digest: digestPlaceCard(null, photo, content), art: null, photo, content };
}

/**
 * Load a board or home board card, or `null` for the 404. `boardBySlug` is the
 * gate and everything drawn comes from it, so a `hideLocation` board draws no
 * location because the schema returned none.
 *
 * `boardBySlug` reads a home board's slug as its link, and an Unlisted board
 * opens for a link holder. A card is not that: it would advertise a board its
 * owner kept out of listings, so an Unlisted board needs the no-link reading too.
 */
export function loadBoardPlaceCard(slug: string, fontFamily: string): Promise<LoadedOgFamilyCard | null> {
  return coalesceCardLoad(`place-board:${slug}`, async () => {
    const context = createAnonymousOgContext();
    const { boardBySlug: board } = await runOgDocument<{ boardBySlug: BoardForCard | null }>(
      OG_PLACE_BOARD,
      { slug },
      context,
    );
    if (!board) return null;
    if (!(await canAccessResourceWithoutLink('board', board.uuid, null))) return null;

    if (board.boardType === 'spray') return loadSprayPlaceCard(board, fontFamily);

    const config: BoardConfig = {
      boardName: board.boardType as BoardName,
      layoutId: board.layoutId,
      sizeId: board.sizeId,
      setIds: board.setIds,
    };
    // A stale config drops the art, not the card: the name is still true.
    const art = isRenderableConfig(config) ? await buildBoardArt(config, board.angle) : null;
    const content = buildBoardCardContent({ board, config, hasArt: !!art, fontFamily });
    return { digest: digestPlaceCard(art, null, content), art, photo: null, content };
  });
}
