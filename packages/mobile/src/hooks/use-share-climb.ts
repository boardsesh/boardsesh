import { useCallback } from 'react';
import { Platform, Share } from 'react-native';
import { buildReadableClimbViewPath } from '@boardsesh/play-view/readable-url-utils';
import { toFlatFrames } from '@boardsesh/board-constants/hold-states';
import { BOARD_FIELD_COLORS } from '@boardsesh/board-look';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import { BACKEND_URL, CLIMB_SHARE_BASE_URL } from '../lib/env';

type ShareClimbArgs = {
  climb: Climb | null;
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};

// Local builder for the backend og:image URL. Kept local rather than pulling in
// @boardsesh/board-render, whose graph drags the WASM renderer + sharp into the
// mobile bundle — far heavier than assembling a query string warrants. The raw
// query string need not byte-match web's buildOgBoardRenderUrl: the backend
// canonicalises set_ids (sort + dedupe) before keying its caches, so both
// platforms' URLs collapse to the same cache entry.
//
// The render params DO have to match, though. This URL only warms a cache — the
// card a crawler actually fetches is the one in www's og:image — so if the two
// disagree on the drawing, the prewarm heats an entry nobody asks for and the
// reader waits on a cold render instead.
/**
 * The card's text params, omitting anything empty.
 *
 * Normalisation is the backend's job — it has to redo it for any caller anyway —
 * so this only trims and drops blanks. An empty `s=` would still change the URL,
 * and the URL is the cache key.
 */
/**
 * Mirrors `OG_CARD_GRADE_PATTERN` in
 * `packages/shared/board-render/src/validation.ts`.
 *
 * Copied rather than imported because this module is in the app bundle, and
 * `@boardsesh/board-render`'s graph drags the WASM renderer and sharp in with
 * it — the same reason the note above gives for hand-building this query
 * string. `util.test.ts` on the web side reads this file and fails if the two
 * stop matching.
 */
const OG_CARD_GRADE_PATTERN = /^[A-Za-z0-9+/. -]{1,16}$/;

function toCardGrade(grade: string | null | undefined): string | undefined {
  const trimmed = grade?.trim();
  return trimmed && OG_CARD_GRADE_PATTERN.test(trimmed) ? trimmed : undefined;
}

function identityParams(identity: {
  name: string | null | undefined;
  grade: string | null | undefined;
  setter: string | null | undefined;
  angle: number;
}): string[] {
  const entries: [string, string | undefined][] = [
    ['n', identity.name?.trim()],
    // Matched, not just trimmed: a grade the backend rejects is a 400, so
    // sending one warms nothing AND warms a different URL than the card a
    // crawler will actually fetch.
    ['g', toCardGrade(identity.grade)],
    ['s', identity.setter?.trim()],
    ['angle', String(identity.angle)],
  ];

  return entries
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`);
}

function buildOgImageUrl(args: {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  frames: string | null | undefined;
  name: string | null | undefined;
  grade: string | null | undefined;
  setter: string | null | undefined;
  angle: number;
}): string | null {
  // A spray wall's holds and photo live in `spray_wall_holds` and the private
  // bucket, and the backend's OG renderer only knows the bundled catalogue
  // geometry — so `/og/climb` cannot draw a wall today, and warming it would
  // cache a blank card under the very URL the unfurler is about to ask for.
  // Teaching the renderer the wall is SW-16's job (the public-wall share card);
  // until then the link still shares, it just unfurls without a picture.
  if (args.boardName === 'spray') return null;
  const flatFrames = toFlatFrames(args.frames, args.boardName as BoardName);
  // The backend rejects an empty frames string (a blank board would cache as a
  // real card), so there is nothing to warm without frames.
  if (!flatFrames) return null;
  const sortedSetIds = args.setIds
    .split(',')
    .map(Number)
    .sort((first, second) => first - second)
    .join(',');
  const query = [
    `board_name=${encodeURIComponent(args.boardName)}`,
    `layout_id=${args.layoutId}`,
    `size_id=${args.sizeId}`,
    `set_ids=${encodeURIComponent(sortedSetIds)}`,
    `frames=${encodeURIComponent(flatFrames)}`,
    'format=jpeg',
    // Kept in step with web's buildOgBoardRenderUrl: the dark play field is the
    // one the app's own play view composites over, so the card and the board a
    // climber just looked at are quieted by the same wash.
    'render_mode=aura',
    `field_color=${encodeURIComponent(BOARD_FIELD_COLORS.dark)}`,
    // The climb identity drawn in the card's right column. Part of the URL and
    // therefore part of the cache key, so warming without it would heat a card
    // that no unfurler is about to ask for — exactly the failure the note above
    // describes for the render params.
    ...identityParams({ name: args.name, grade: args.grade, setter: args.setter, angle: args.angle }),
  ].join('&');
  return `${BACKEND_URL}/og/climb?${query}`;
}

// Fire-and-forget priming before the native share sheet opens — the same
// warm-the-CDN-and-og-caches trick web does. Never blocks or breaks sharing:
// each fetch is voided and every failure (async rejection or a synchronous
// throw when fetch is unavailable) is swallowed.
function prewarmShareCaches(urls: string[]): void {
  for (const target of urls) {
    try {
      void fetch(target)
        .then((response) => response.body?.cancel())
        .catch(() => {});
    } catch {
      // Priming is best-effort; a warm miss must never affect the share sheet.
    }
  }
}

export function useShareClimb({ climb, boardName, layoutId, sizeId, setIds, angle }: ShareClimbArgs) {
  return useCallback(async () => {
    if (!climb) return;
    const url = `${CLIMB_SHARE_BASE_URL}${buildReadableClimbViewPath({
      boardName,
      layoutId,
      sizeId,
      setIds,
      angle,
      climbUuid: climb.uuid,
      climbName: climb.name,
    })}`;

    const ogImageUrl = buildOgImageUrl({
      boardName,
      layoutId,
      sizeId,
      setIds,
      frames: climb.frames,
      name: climb.name,
      grade: climb.difficulty,
      setter: climb.setter_username,
      angle,
    });
    prewarmShareCaches(ogImageUrl ? [url, ogImageUrl] : [url]);

    await Share.share(Platform.OS === 'ios' ? { message: climb.name, url } : { message: `${climb.name}\n${url}` });
  }, [climb, boardName, layoutId, sizeId, setIds, angle]);
}
