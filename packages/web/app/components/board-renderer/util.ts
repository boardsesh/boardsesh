import { accumulateFramesToMaps, accumulatedMapsToFrameStrings } from '@boardsesh/board-constants/hold-states';
import type { BoardDetails, BoardName } from '@/app/lib/types';
import { BOARD_IMAGE_DIMENSIONS } from '../../lib/board-data';
export { convertLitUpHoldsStringToMap } from './types';
// Multi-frame playback primitives now live in the shared, renderer-agnostic
// package so web and mobile share one engine. Re-exported here so existing
// web importers keep their `board-renderer/util` import path.
//
// Import from the per-module subpaths, NOT the package barrel: this file is
// reachable from server components (board image URL builders below), and the
// barrel re-exports the playback engine, which uses useState/useEffect. Pulling
// that into the RSC server graph is a build error. `use-climb-frames` (useMemo
// only) and `pace` (constants) are server-safe; the engine stays client-only.
export { useClimbFrames, type ClimbFrames } from '@boardsesh/playback-react/use-climb-frames';
export { MIN_PACE_MS, DEFAULT_PACE_MS } from '@boardsesh/playback-react/pace';

type BuildBoardRenderUrlOptions = {
  thumbnail?: boolean;
  includeBackground?: boolean;
  variant?: 'default' | 'og';
  format?: 'webp' | 'png' | 'jpg' | 'jpeg';
};

/**
 * Build the URL for the Rust/WASM-rendered board image.
 * Mirroring is handled via CSS (scaleX(-1)), not a separate render — halves cache variants.
 */
export const buildBoardRenderUrl = (
  boardDetails: BoardDetails,
  frames: string,
  { thumbnail, includeBackground, variant, format }: BuildBoardRenderUrlOptions = {},
) => {
  let url =
    `/api/internal/board-render?board_name=${boardDetails.board_name}` +
    `&layout_id=${boardDetails.layout_id}` +
    `&size_id=${boardDetails.size_id}` +
    `&set_ids=${boardDetails.set_ids.join(',')}` +
    `&frames=${encodeURIComponent(frames)}`;

  if (thumbnail) {
    url += '&thumbnail=1';
  }

  if (includeBackground) {
    url += '&include_background=1';
  }

  if (variant === 'og') {
    url += '&variant=og';
  }

  if (format) {
    url += `&format=${format}`;
  }

  return url;
};

/**
 * Collapse a (possibly multi-frame) Aurora frames string into the flat
 * final-snapshot form that the Rust/WASM board renderer and the ESP32
 * controller can parse — a sequence of `p<id>r<role>` pairs with no commas
 * and no `x<id>` off tokens.
 *
 * Single-frame climbs round-trip identically (the input already has no
 * commas or `x` tokens). Multi-frame climbs collapse to the cumulative
 * final lit state — what a viewer wants to see in a social card or
 * overlay thumbnail, and what the ESP32 needs to light a full circuit.
 *
 * Passing a raw multi-frame string into the renderer / controller would
 * either render only frame 0 (commas as delimiters) or emit garbage —
 * always run user-facing frames through this before crossing that
 * boundary. The empty string is preserved unchanged.
 */
export const toFlatFrames = (frames: string | null | undefined, boardName: BoardName): string => {
  if (!frames) return '';
  if (!frames.includes(',') && !frames.includes('x')) return frames;
  const maps = accumulateFramesToMaps(frames, boardName);
  return accumulatedMapsToFrameStrings(maps, boardName).at(-1) ?? '';
};

export const buildOverlayUrl = (boardDetails: BoardDetails, frames: string, thumbnail?: boolean) =>
  buildBoardRenderUrl(boardDetails, toFlatFrames(frames, boardDetails.board_name), {
    thumbnail,
    includeBackground: true,
  });

export const buildOgBoardRenderUrl = (boardDetails: BoardDetails, frames: string) =>
  buildBoardRenderUrl(boardDetails, toFlatFrames(frames, boardDetails.board_name), {
    includeBackground: true,
    variant: 'og',
    format: 'png',
  });

const USE_SELF_HOSTED_IMAGES = true;

/** Insert /thumbs/ before the filename in a WebP path, or return as-is. */
const toThumbUrl = (webpUrl: string) => {
  const lastSlash = webpUrl.lastIndexOf('/');
  return `${webpUrl.substring(0, lastSlash)}/thumbs${webpUrl.substring(lastSlash)}`;
};

export const getImageUrl = (imageUrl: string, board: BoardName, thumbnail?: boolean) => {
  // Absolute path (e.g. MoonBoard images already prefixed with /images/moonboard/...)
  if (imageUrl.startsWith('/')) {
    const webpUrl = imageUrl.replace(/\.png$/, '.webp');
    return thumbnail ? toThumbUrl(webpUrl) : webpUrl;
  }

  if (USE_SELF_HOSTED_IMAGES) {
    const webpUrl = `/images/${board}/${imageUrl}`.replace(/\.png$/, '.webp');
    return thumbnail ? toThumbUrl(webpUrl) : webpUrl;
  }

  return `https://api.${board}boardapp${board === 'tension' ? '2' : ''}.com/img/${imageUrl}`;
};

export const getBoardImageDimensions = (board: BoardName, firstImage: string) =>
  BOARD_IMAGE_DIMENSIONS[board][firstImage];
