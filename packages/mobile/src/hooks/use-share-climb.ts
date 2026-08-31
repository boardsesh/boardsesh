import { useCallback } from 'react';
import { Platform, Share } from 'react-native';
import { buildReadableClimbViewPath } from '@boardsesh/play-view/readable-url-utils';
import { toFlatFrames } from '@boardsesh/board-constants/hold-states';
import { supportsStaticBoardRender } from '@boardsesh/board-config';
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
function buildOgImageUrl(args: {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  frames: string | null | undefined;
}): string | null {
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
    // Shared links currently land on the legacy www view and prewarm its
    // synchronous renderer. Runtime-only Quantum geometry has neither surface;
    // callers also hide the affordance, and this guard keeps direct use safe.
    if (!climb || !supportsStaticBoardRender(boardName)) return;
    const url = `${CLIMB_SHARE_BASE_URL}${buildReadableClimbViewPath({
      boardName,
      layoutId,
      sizeId,
      setIds,
      angle,
      climbUuid: climb.uuid,
      climbName: climb.name,
    })}`;

    const ogImageUrl = buildOgImageUrl({ boardName, layoutId, sizeId, setIds, frames: climb.frames });
    prewarmShareCaches(ogImageUrl ? [url, ogImageUrl] : [url]);

    await Share.share(Platform.OS === 'ios' ? { message: climb.name, url } : { message: `${climb.name}\n${url}` });
  }, [climb, boardName, layoutId, sizeId, setIds, angle]);
}
