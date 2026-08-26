import { toFlatFrames as toFlatFramesShared } from '@boardsesh/board-constants/hold-states';
// Leaf subpath, not the package barrel: this module compiles into the client
// bundle, and the barrel pulls in the render pipeline. The generated constant
// has no imports at all.
import { BOARD_RENDER_VERSION } from '@boardsesh/board-render/version';
import type { BoardDetails, BoardName } from '@/app/lib/types';
import { getPublicBackendHttpUrl } from '@/app/lib/backend-url';
import { resolveStaticAssetUrl } from '@/app/lib/static-asset-url';
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
  /** Ask for the dark art siblings. Only meaningful for boards in `BOARDS_WITH_DARK_ART`. */
  colorScheme?: 'light' | 'dark';
};

const LEGACY_BOARD_RENDER_PATH = '/api/internal/board-render';
const BACKEND_BOARD_RENDER_PATH = '/render/board';

function shouldUseCompatibilityPath(): boolean {
  // The dev orchestrator advertises its Tailscale hostname to the browser even
  // though SSR runs in the same worktree. Keep both sides on one relative URL
  // so local hostnames and ports cannot produce different hydrated markup.
  if (process.env.NODE_ENV === 'development') return true;

  const configuredWsUrl = process.env.NEXT_PUBLIC_WS_URL;
  if (!configuredWsUrl) return true;

  try {
    const hostname = new URL(configuredWsUrl).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '[::1]';
  } catch {
    return true;
  }
}

/**
 * Boards whose art has a dark-mode sibling committed under public/images.
 *
 * Woods is the only one on web: its art is hold sprites on an opaque white ground, which in
 * dark mode renders as a lit rectangle, so scripts/generate-woods-dark-art.ts keys that
 * ground out (issue #4753). MoonBoard has dark files too, but they were tuned against the
 * mobile app's surfaces and are not wired up here yet.
 *
 * This gate is what keeps the theme swap from doubling requests and server renders for every
 * other board — those would render identical bytes twice.
 *
 * Unlike mobile, which falls back when a key is absent from its bundle manifest, a missing
 * file here is a 404 — so util.test.ts walks the listed boards' image directories and fails
 * if any light `.webp` has lost its dark sibling.
 */
export const BOARDS_WITH_DARK_ART: ReadonlySet<string> = new Set(['woods']);

export const hasDarkBoardArt = (board: BoardName) => BOARDS_WITH_DARK_ART.has(board);

/**
 * Production and preview HTML point straight at Railway so a cache miss never
 * invokes Vercel. Local/LAN development keeps the same-origin compatibility
 * path: the configured URL is commonly localhost on the server but the browser
 * sees a LAN hostname, and choosing different absolute origins would create an
 * SSR/hydration mismatch.
 */
function getBoardRenderEndpoint(): string {
  if (shouldUseCompatibilityPath()) return LEGACY_BOARD_RENDER_PATH;
  const backendOrigin = getPublicBackendHttpUrl();
  return backendOrigin ? `${backendOrigin}${BACKEND_BOARD_RENDER_PATH}` : LEGACY_BOARD_RENDER_PATH;
}

/**
 * Build the URL for the Rust/WASM-rendered board image on the Railway backend.
 * Mirroring is handled via CSS (scaleX(-1)), not a separate render — halves cache variants.
 *
 * The trailing `&v=` is the renderer version (#4773). Board-render responses are
 * cached `immutable` for a year, and Cloudflare — unlike Vercel — does not purge on
 * deploy, so without it a change to the renderer, the sharp pipeline, board geometry
 * or the board photos would keep serving the old pixels to everyone who already had
 * them. The version is derived, not hand-bumped: see
 * `scripts/generate-board-render-version.ts`.
 */
export const buildBoardRenderUrl = (
  boardDetails: BoardDetails,
  frames: string,
  { thumbnail, includeBackground, variant, format, colorScheme }: BuildBoardRenderUrlOptions = {},
) => {
  let url =
    `${getBoardRenderEndpoint()}?board_name=${boardDetails.board_name}` +
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

  if (colorScheme === 'dark') {
    url += '&color_scheme=dark';
  }

  // Last, always: it reads as the version stamp in a log line, and the route's
  // byte cache deliberately ignores it (one process only ever runs one renderer).
  url += `&v=${BOARD_RENDER_VERSION}`;

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
/**
 * Flatten a possibly multi-frame frames string before it crosses the renderer
 * or BLE boundary — raw multi-frame strings render only frame 0 or emit
 * garbage. Delegates to the shared implementation in board-constants.
 */
export const toFlatFrames = (frames: string | null | undefined, boardName: BoardName): string =>
  toFlatFramesShared(frames, boardName);

export const buildOverlayUrl = (
  boardDetails: BoardDetails,
  frames: string,
  thumbnail?: boolean,
  colorScheme?: 'light' | 'dark',
) =>
  buildBoardRenderUrl(boardDetails, toFlatFrames(frames, boardDetails.board_name), {
    thumbnail,
    includeBackground: true,
    colorScheme,
  });

export type BoardArtLayers = {
  /**
   * Static board-art layers, as light URLs. Empty when the overlay already bakes the board
   * photo in; non-empty means the caller must also render each URL's `toDarkArtUrl` twin and
   * let the stylesheet pick.
   */
  backgroundUrls: string[];
  /** The per-climb hold render. Includes the board photo only when `backgroundUrls` is empty. */
  overlayUrl: string | null;
};

/**
 * How to draw one climb's board art, split so a themed board never doubles the render cost.
 *
 * Boards without dark art keep the server-composited image they always had: one request,
 * board photo and holds baked together, shared by every viewer.
 *
 * Boards with dark art cannot use that composite for both themes. Its URL carries the
 * climb's frames, so a dark twin is a *second* WASM + sharp render per climb — 50 of them on
 * a front-door list, which is exactly the work `warmOverlays` caps itself to avoid. The holds
 * overlay is identical in both themes though; only the board photo behind it differs. So the
 * photo splits back out as static art (two files per board size, shared by every card on the
 * page) and the overlay renders once with no background baked in.
 */
export const buildBoardArtLayers = (
  boardDetails: BoardDetails,
  frames: string | null | undefined,
  thumbnail?: boolean,
): BoardArtLayers => {
  if (!hasDarkBoardArt(boardDetails.board_name)) {
    return {
      backgroundUrls: [],
      overlayUrl: frames ? buildOverlayUrl(boardDetails, frames, thumbnail) : null,
    };
  }

  return {
    backgroundUrls: Object.keys(boardDetails.images_to_holds).map((image) =>
      getImageUrl(image, boardDetails.board_name, thumbnail),
    ),
    overlayUrl: frames
      ? buildBoardRenderUrl(boardDetails, toFlatFrames(frames, boardDetails.board_name), { thumbnail })
      : null,
  };
};

/**
 * The board images a page should preload when it treats one as its LCP element.
 *
 * One URL for most boards. Boards with dark art put both variants in the markup and let CSS
 * choose, so both are preloaded: the browser fetches both either way, and hinting only the
 * light one leaves a dark-mode reader's actual LCP element unprioritised.
 */
export const buildOverlayPreloadUrls = (
  boardDetails: BoardDetails,
  frames: string | null | undefined,
  thumbnail?: boolean,
): string[] => {
  if (!frames) return [];

  const { backgroundUrls, overlayUrl } = buildBoardArtLayers(boardDetails, frames, thumbnail);
  if (!overlayUrl) return [];

  // On a themed board the visible LCP element is the board photo plus the overlay stacked, so
  // hint all of it. The photo layers are static files every card on the page shares, and both
  // themes' copies are fetched regardless — hinting only the light one would leave a
  // dark-mode reader's actual pixels unprioritised.
  return [overlayUrl, ...backgroundUrls.flatMap((url) => [url, toDarkArtUrl(url)])];
};

/**
 * OG card image for a shared climb. Points at the backend `/og/climb` endpoint
 * (long-running process, warm renderer, JPEG by default) as an absolute URL so
 * crawlers fetch it directly instead of the slow Vercel render path. When the
 * backend origin can't be resolved (misconfigured env, some test contexts) it
 * falls back to the web board-render route unchanged.
 *
 * The backend branch deliberately carries no `v=`: mobile builds the same
 * `/og/climb` URL independently (`packages/mobile/src/hooks/use-share-climb.ts`)
 * from a shipped binary, so versioning it on this side alone would split the edge
 * entry in two instead of versioning it. `/og/climb` gets its own fix — do not
 * "helpfully" add `v` here. The fallback branch goes through
 * `buildBoardRenderUrl` and is versioned like every other web producer.
 */
export const buildOgBoardRenderUrl = (boardDetails: BoardDetails, frames: string) => {
  const flatFrames = toFlatFrames(frames, boardDetails.board_name);
  const backendOrigin = getPublicBackendHttpUrl();

  if (backendOrigin) {
    const backendParams = new URLSearchParams({
      board_name: boardDetails.board_name,
      layout_id: String(boardDetails.layout_id),
      size_id: String(boardDetails.size_id),
      set_ids: boardDetails.set_ids.join(','),
      frames: flatFrames,
      format: 'jpeg',
    });
    return `${backendOrigin}/og/climb?${backendParams}`;
  }

  return buildBoardRenderUrl(boardDetails, flatFrames, {
    includeBackground: true,
    variant: 'og',
    format: 'png',
  });
};

const USE_SELF_HOSTED_IMAGES = true;

/** Insert /thumbs/ before the filename in a WebP path, or return as-is. */
const toThumbUrl = (webpUrl: string) => {
  const lastSlash = webpUrl.lastIndexOf('/');
  return `${webpUrl.substring(0, lastSlash)}/thumbs${webpUrl.substring(lastSlash)}`;
};

/**
 * Dark-mode sibling of a WebP art path: `foo.webp` -> `foo.dark.webp`.
 *
 * Same convention as `DARK_VARIANT_SUFFIX` in the mobile app's background-image-cache.ts,
 * written by scripts/generate-dark-board-art.ts and scripts/generate-woods-dark-art.ts. Only
 * Woods ships these on web today — callers are responsible for knowing a sibling exists,
 * because a missing one 404s rather than falling back the way the mobile manifest does.
 */
export const toDarkArtUrl = (webpUrl: string) => webpUrl.replace(/\.webp$/, '.dark.webp');

export const getImageUrl = (imageUrl: string, board: BoardName, thumbnail?: boolean) => {
  // Absolute path (e.g. MoonBoard images already prefixed with /images/moonboard/...)
  if (imageUrl.startsWith('/')) {
    const webpUrl = imageUrl.replace(/\.png$/, '.webp');
    return resolveStaticAssetUrl(thumbnail ? toThumbUrl(webpUrl) : webpUrl);
  }

  if (USE_SELF_HOSTED_IMAGES) {
    const webpUrl = `/images/${board}/${imageUrl}`.replace(/\.png$/, '.webp');
    return resolveStaticAssetUrl(thumbnail ? toThumbUrl(webpUrl) : webpUrl);
  }

  return `https://api.${board}boardapp${board === 'tension' ? '2' : ''}.com/img/${imageUrl}`;
};

export const getBoardImageDimensions = (board: BoardName, firstImage: string) =>
  BOARD_IMAGE_DIMENSIONS[board][firstImage];
