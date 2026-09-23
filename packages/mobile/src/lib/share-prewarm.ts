import { toFlatFrames } from '@boardsesh/board-constants/hold-states';
import { BOARD_FIELD_COLORS } from '@boardsesh/board-look';
import type { BoardName } from '@boardsesh/shared-schema';
import { BACKEND_URL } from './env';

// Fallback builder for the backend og:image URL, used only when the page will
// not tell us its own card (see `readAdvertisedCard`).
//
// Kept local rather than pulling in @boardsesh/board-render, whose graph drags
// the WASM renderer + sharp into the mobile bundle — far heavier than assembling
// a query string warrants. The backend canonicalises set_ids (sort + dedupe)
// before keying its caches, so this URL and web's collapse to the same entry.
//
// It carries NO climb identity (`n`/`g`/`s`/`angle`), because the app cannot
// reproduce what www advertises: the angle there is `selectCanonicalClimbAngle`,
// picked from every angle's ascent counts. Measured against production — the
// same climb served at /25/, /40/ and /50/ all advertise `angle=40` — so there
// is no local arithmetic that arrives at it.
//
// So this warms the per-board `ogBase` (the backdrop with the board photos
// composited, keyed on board config and render size, NOT on the climb) and not
// the card an unfurler actually asks for. It is still issued first, because the
// backdrop is shared and the real card's render turns from a `miss` into a
// `base-hit` once it lands — but the page's own og:image is what actually gets
// the reader a picture, and `prewarmShareCaches` goes after both.
export function buildOgImageUrl(args: {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  frames: string | null | undefined;
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
  ].join('&');
  return `${BACKEND_URL}/og/climb?${query}`;
}

// The card the unfurler will ask for, read from the page that advertises it.
//
// This exists because the app cannot compute that URL (see `buildOgImageUrl`)
// and the near-miss it *can* compute is a different cache key at both layers —
// Cloudflare and the backend's own byte cache. Fetched back to back against
// production, the app-shaped URL came back MISS while www's came back HIT: the
// old prewarm was heating a URL nobody ever requests, leaving the real card to
// be rendered cold while the reader waited on it.
//
// Reading the body costs about 69 KB gzipped on the wire. All of it: `text()`
// buffers the whole response, and the limit below bounds the regex walk, not the
// download — React Native's fetch has no usable streaming body to stop early on.
// The tag sits ~1.5% into the document, so the walk stops almost immediately,
// but the bytes are already paid for by then.
const OG_IMAGE_SCAN_LIMIT = 64 * 1024;
const META_TAG_PATTERN = /<meta\b[^>]*>/gi;
const OG_IMAGE_PROPERTY_PATTERN = /property=["']og:image["']/i;
const META_CONTENT_PATTERN = /content=["']([^"']*)["']/i;

function decodeHtmlAttribute(value: string): string {
  // `&amp;` is the one that matters — a card URL carries six query separators —
  // but the others cost nothing and a half-decoded URL warms the wrong entry.
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&#x27;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

export function extractOgImageUrl(html: string): string | null {
  // Bounded on both ends: stop at `</head>` when there is one, and never scan
  // more than the limit either way, so a huge or malformed document cannot turn
  // a share tap into a long regex walk. A tag past the limit reads as absent and
  // falls back, which is the same outcome as a page that carries no card.
  const headEnd = html.indexOf('</head>');
  const head = html.slice(0, Math.min(headEnd === -1 ? OG_IMAGE_SCAN_LIMIT : headEnd, OG_IMAGE_SCAN_LIMIT));
  for (const tag of head.match(META_TAG_PATTERN) ?? []) {
    // Attribute order is not guaranteed, so the tag is matched first and its
    // content read second rather than assuming `property` precedes `content`.
    if (!OG_IMAGE_PROPERTY_PATTERN.test(tag)) continue;
    const content = META_CONTENT_PATTERN.exec(tag);
    if (!content?.[1]) continue;
    const url = decodeHtmlAttribute(content[1]);
    // Only ever fetch our own backend. The page is ours, but a prewarm that
    // follows whatever a response puts in og:image is a request forwarder.
    if (!url.startsWith(`${BACKEND_URL}/`)) continue;
    return url;
  }
  return null;
}

// How long to wait on the page before giving up on reading its card.
//
// The share sheet is already open by now and the reader is picking a recipient,
// so this is not a UI deadline — it is the point past which a stalled request
// would go on holding up the warm behind it.
export const PAGE_READ_TIMEOUT_MS = 4000;

async function warm(url: string): Promise<void> {
  try {
    const response = await fetch(url);
    await response.body?.cancel();
  } catch {
    // Priming is best-effort; a warm miss must never affect the share sheet.
  }
}

async function readAdvertisedCard(pageUrl: string): Promise<string | null> {
  const abort = new AbortController();
  const expiry = setTimeout(() => abort.abort(), PAGE_READ_TIMEOUT_MS);
  try {
    // Warming the page is half the win on its own: an unfurler fetches it
    // before it ever looks for an image.
    const page = await fetch(pageUrl, { signal: abort.signal });
    return extractOgImageUrl(await page.text());
  } catch {
    return null;
  } finally {
    clearTimeout(expiry);
  }
}

// Fire-and-forget priming before the native share sheet opens — the same
// warm-the-CDN-and-og-caches trick web does. Never blocks or breaks sharing:
// every failure (async rejection, or a synchronous throw when fetch is
// unavailable) is swallowed, and the caller does not await it.
export async function prewarmShareCaches(pageUrl: string, fallbackOgImageUrl: string | null): Promise<void> {
  // Started first, and deliberately not awaited before the page read.
  //
  // Reading the advertised card costs a page fetch and its body, so gating all
  // warming on that would leave the backend idle for the whole download — and
  // the sheet is open the entire time, so the reader can send before any of it
  // lands. This request shares the per-board `ogBase` with the real card (the
  // backdrop with the board photos composited, keyed on board config, not on
  // the climb), so it turns the real card's render from a `miss` into a
  // `base-hit` whoever asks for it first.
  const backdrop = fallbackOgImageUrl ? warm(fallbackOgImageUrl) : Promise.resolve();

  const advertised = await readAdvertisedCard(pageUrl);
  if (advertised) await warm(advertised);
  await backdrop;
}
