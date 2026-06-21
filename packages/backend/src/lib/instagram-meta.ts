import {
  getInstagramMediaId,
  INSTAGRAM_URL_REGEX,
  isInstagramUrl,
  normalizeBetaVideoUrl,
} from '@boardsesh/shared-schema';
import { createCircuitBreaker } from './circuit-breaker';
import { logger } from '../utils/logger';

export { INSTAGRAM_URL_REGEX, isInstagramUrl, getInstagramMediaId, normalizeBetaVideoUrl };

const FETCH_TIMEOUT_MS = 4000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

// Cap the HTML body we accept from Instagram. AbortSignal.timeout() bounds
// wall-clock, but without a byte cap a hostile or compromised endpoint over a
// fast pipe can exhaust process memory before the timeout fires. IG embed
// pages are typically a few hundred KB; 1 MB is generous.
const MAX_HTML_BYTES = 1024 * 1024;

// Instagram usernames are 1–30 chars from [a-z0-9_.] (case-insensitive) with
// no leading or trailing dot. Apply this to any captured username before
// returning it so a malformed embed response can't poison
// boardBetaLinks.foreign_username with garbage.
const INSTAGRAM_USERNAME_REGEX = /^[a-z0-9_](?:[a-z0-9_.]{0,28}[a-z0-9_])?$/i;

function sanitizeInstagramUsername(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  return INSTAGRAM_USERNAME_REGEX.test(candidate) ? candidate : null;
}

// Sentinel for body-size-cap rejections. Surfaced through the catch in
// fetchInstagramMetaUncached so the outer wrapper can map it to
// transient_error WITHOUT recording a circuit-breaker failure: an oversized
// body is a defense against our own memory pressure, not a signal that IG
// is degraded. Tripping the breaker on a single bad response would stop
// legitimate fetches for the whole cooldown window.
class HtmlBodyTooLargeError extends Error {
  constructor() {
    super('html body exceeded cap');
    this.name = 'HtmlBodyTooLargeError';
  }
}

async function readBodyWithCap(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) {
    // Some fetch implementations / tests return a mock without a streamable
    // body. Fall back to res.text() + post-hoc length check so we still
    // enforce the cap, just at the cost of buffering up to maxBytes first.
    //
    // text.length counts UTF-16 code units, not bytes; a body full of 4-byte
    // UTF-8 characters can slip past a byte-denominated cap. Measure actual
    // UTF-8 byte length instead.
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new HtmlBodyTooLargeError();
    }
    return text;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let total = 0;
  let html = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // best-effort
      }
      throw new HtmlBodyTooLargeError();
    }
    html += decoder.decode(value, { stream: true });
  }
  html += decoder.decode();
  return html;
}

export const INSTAGRAM_META_TTL_MS = 10 * 60 * 1000;
// Cache transient errors briefly so a rate-limit / login-wall response from
// Instagram doesn't make us refetch on every read of every beta link. Short
// enough that we recover quickly when IG comes back, long enough to break
// the request-per-read pattern under load.
export const INSTAGRAM_TRANSIENT_TTL_MS = 2 * 60 * 1000;

// Circuit breaker: if we observe a burst of transient errors, stop calling
// out for a cooldown so we don't keep poking IG while it's actively
// throttling us. The resolver layer keeps serving cached thumbnails during
// the open window (see enrichRow's transient_error handling). State scope
// (per-process vs. fleet-wide) is documented on createCircuitBreaker.
const CIRCUIT_WINDOW_MS = 60 * 1000;
const CIRCUIT_THRESHOLD = 10;
const CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;

export type InstagramMetaResult =
  | { status: 'ok'; thumbnail: string; username: string | null; caption: string | null }
  | { status: 'gone' }
  | { status: 'transient_error' };

// Internal variant carries a hint about whether this transient_error should
// count toward the circuit breaker. Body-cap rejections don't — they're a
// local defense, not an IG-availability signal.
type UncachedResult =
  | { status: 'ok'; thumbnail: string; username: string | null; caption: string | null }
  | { status: 'gone' }
  | { status: 'transient_error'; tripBreaker: boolean };

// Cap the caption we keep. Matching a climb only needs the name, and the UI
// preview truncates anyway — this guards against a pathological multi-KB body.
const MAX_CAPTION_LENGTH = 2000;

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#064;/g, '@')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function decodeJsonString(s: string): string {
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return s;
  }
}

/**
 * Grab the inner HTML of the first `<div class="<className>">` while respecting
 * nested `<div>`s — the captioned embed wraps the username in a nested div, so a
 * non-greedy regex to the first `</div>` truncates the caption. Walks div
 * open/close tags to find the matching close. Returns null if not found.
 */
function extractDivContentByClass(html: string, className: string): string | null {
  const classMatch = new RegExp(`class=["']${className}["']`, 'i').exec(html);
  if (!classMatch) return null;
  const openTagEnd = html.indexOf('>', classMatch.index);
  if (openTagEnd === -1) return null;
  const contentStart = openTagEnd + 1;
  const divTag = /<(\/?)div\b[^>]*>/gi;
  divTag.lastIndex = contentStart;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = divTag.exec(html)) !== null) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return html.slice(contentStart, match.index);
  }
  return null;
}

/**
 * Best-effort caption extraction from the /embed/captioned/ page. Caption is a
 * convenience for auto-matching the climb on share — never required, so any
 * parse miss returns null and the user picks the climb manually. Tries the
 * structured JSON (cleanest), then the rendered `.Caption` div (the whole point
 * of the captioned variant), then the og:description meta.
 */
export function extractInstagramCaption(html: string, username: string | null): string | null {
  const cap = (text: string): string | null => {
    const trimmed = text.trim();
    return trimmed ? trimmed.slice(0, MAX_CAPTION_LENGTH) : null;
  };

  const fromEdge = html.match(
    /"edge_media_to_caption"\s*:\s*\{\s*"edges"\s*:\s*\[\s*\{\s*"node"\s*:\s*\{\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"/,
  );
  if (fromEdge) {
    const text = cap(decodeJsonString(fromEdge[1]));
    if (text) return text;
  }

  // Require a `{`/`,` before the key so we don't latch onto "accessibility_caption".
  const fromCaptionField = html.match(/[,{]\s*"caption"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (fromCaptionField) {
    const text = cap(decodeJsonString(fromCaptionField[1]));
    if (text) return text;
  }

  const captionDiv = extractDivContentByClass(html, 'Caption');
  if (captionDiv) {
    // The caption div nests a "View all N comments" block (.CaptionComments)
    // and sometimes a timestamp after the caption text — cut them off.
    const commentsIdx = captionDiv.search(/class=["']Caption(?:Comments|Time)["']/i);
    const captionOnly =
      commentsIdx === -1
        ? captionDiv
        : captionDiv.slice(
            0,
            captionDiv.lastIndexOf('<div', commentsIdx) === -1
              ? commentsIdx
              : captionDiv.lastIndexOf('<div', commentsIdx),
          );
    let text = decodeHtmlEntities(captionOnly.replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
    // The CaptionUsername link renders the poster's handle as the first token.
    if (username && text.toLowerCase().startsWith(username.toLowerCase())) {
      text = text.slice(username.length).trim();
    }
    const capped = cap(text);
    if (capped) return capped;
  }

  const ogDescription = html.match(/property=["']og:description["']\s+content=["']([^"']*)["']/i)?.[1];
  if (ogDescription) {
    const decoded = decodeHtmlEntities(ogDescription).trim();
    // IG formats this as: `1,234 likes, 56 comments - username on Instagram: "caption"`.
    const stripped = decoded
      .replace(/^[\d,.]+\s+likes?,\s+[\d,.]+\s+comments?\s+-\s+.*?\son\sInstagram[^:]*:\s*/i, '')
      .replace(/^["“]([\s\S]*)["”]$/, '$1')
      .trim();
    const text = cap(stripped || decoded);
    if (text) return text;
  }

  return null;
}

/**
 * IG sometimes serves a 200 OK login wall (rate limit, age-gate, geo-block)
 * instead of the embed page. The login wall has no `EmbeddedMediaImage` /
 * `og:image` so the regular path would classify it as `gone`. Detect a
 * couple of stable signals so we can map it to `transient_error` instead.
 */
function looksLikeLoginWall(html: string): boolean {
  return (
    /accounts\/login/i.test(html) ||
    /<title>\s*Login\s*[••]\s*Instagram\s*<\/title>/i.test(html) ||
    /Please wait a few minutes before you try again/i.test(html)
  );
}

const metaCache = new Map<string, { data: InstagramMetaResult; expiresAt: number }>();
const inflight = new Map<string, Promise<InstagramMetaResult>>();

const circuit = createCircuitBreaker({
  windowMs: CIRCUIT_WINDOW_MS,
  threshold: CIRCUIT_THRESHOLD,
  cooldownMs: CIRCUIT_COOLDOWN_MS,
  onOpen: (count, cooldownMs) => {
    logger.warn(
      `[instagram-meta] circuit breaker open for ${cooldownMs / 1000}s after ${count} transient errors in ${CIRCUIT_WINDOW_MS / 1000}s`,
    );
  },
});

export function clearInstagramMetaCache(): void {
  metaCache.clear();
  inflight.clear();
  circuit.reset();
}

async function fetchInstagramMetaUncached(url: string): Promise<UncachedResult> {
  const mediaId = getInstagramMediaId(url);
  if (!mediaId) return { status: 'gone' };
  const embedUrl = `https://www.instagram.com/p/${mediaId}/embed/captioned/`;

  let html: string;
  try {
    const res = await fetch(embedUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) return { status: 'transient_error', tripBreaker: true };
    html = await readBodyWithCap(res, MAX_HTML_BYTES);
  } catch (err) {
    // Body-cap rejections are a self-defense, not an IG-availability signal.
    // Surface them as transient_error so the resolver keeps serving cached
    // thumbnails, but don't count them toward the breaker.
    if (err instanceof HtmlBodyTooLargeError) {
      return { status: 'transient_error', tripBreaker: false };
    }
    return { status: 'transient_error', tripBreaker: true };
  }

  // Primary signal: <img class="EmbeddedMediaImage" alt="Instagram post shared by &#064;<user>" src="...p1080x1080..." />
  // The alt and src order isn't guaranteed; try both arrangements.
  const altThenSrc = html.match(
    /<img[^>]*class=["']EmbeddedMediaImage["'][^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']+)["']/i,
  );
  const srcThenAlt = altThenSrc
    ? null
    : html.match(/<img[^>]*class=["']EmbeddedMediaImage["'][^>]*src=["']([^"']+)["'][^>]*alt=["']([^"']*)["']/i);

  let thumbnail: string | null = null;
  let usernameFromAlt: string | null = null;

  if (altThenSrc) {
    thumbnail = decodeHtmlEntities(altThenSrc[2]);
    usernameFromAlt = decodeHtmlEntities(altThenSrc[1]).match(/@([\w._]+)/)?.[1] ?? null;
  } else if (srcThenAlt) {
    thumbnail = decodeHtmlEntities(srcThenAlt[1]);
    usernameFromAlt = decodeHtmlEntities(srcThenAlt[2]).match(/@([\w._]+)/)?.[1] ?? null;
  }

  if (!thumbnail) {
    const ogImageRaw = html.match(/property=["']og:image["']\s+content=["']([^"']+)["']/i)?.[1] ?? null;
    const displayUrlRaw = html.match(/"display_url"\s*:\s*"([^"]+)"/)?.[1] ?? null;
    const thumbnailSrcRaw = html.match(/"thumbnail_src"\s*:\s*"([^"]+)"/)?.[1] ?? null;
    if (ogImageRaw) {
      thumbnail = decodeHtmlEntities(ogImageRaw);
    } else if (displayUrlRaw) {
      thumbnail = decodeJsonString(displayUrlRaw);
    } else if (thumbnailSrcRaw) {
      thumbnail = decodeJsonString(thumbnailSrcRaw);
    } else {
      thumbnail = null;
    }
  }

  if (!thumbnail) {
    // 200 OK but no embedded image — could be a real "post is gone" page
    // *or* a login wall served by Instagram during rate-limit / age-gate /
    // geo-block. Treat the login-wall variants as transient so we don't
    // silently drop a real beta link the next time the resolver runs.
    if (looksLikeLoginWall(html)) {
      return { status: 'transient_error', tripBreaker: true };
    }
    return { status: 'gone' };
  }

  const rawUsername =
    usernameFromAlt ??
    html.match(/"owner"\s*:\s*\{[^}]*"username"\s*:\s*"([^"]+)"/)?.[1] ??
    html.match(/<input[^>]*class=["']EmbedInput["'][^>]*value=["']@?([\w._]+)["']/i)?.[1] ??
    null;
  // Validate against Instagram's username rules before persisting — an
  // anomalous embed response (length, leading/trailing dot, unexpected chars)
  // shouldn't end up in boardBetaLinks.foreign_username.
  const username = sanitizeInstagramUsername(rawUsername);

  const caption = extractInstagramCaption(html, username);

  return { status: 'ok', thumbnail, username, caption };
}

export async function fetchInstagramMeta(url: string): Promise<InstagramMetaResult> {
  const now = Date.now();
  const cached = metaCache.get(url);
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  // Circuit open: short-circuit to transient_error without making a network
  // call. The resolver layer keeps serving cached thumbnails during this
  // window (see enrichRow). Don't poison the meta cache with this synthetic
  // result — once the circuit closes we want to retry normally.
  if (circuit.isOpen()) {
    return { status: 'transient_error' };
  }

  const existing = inflight.get(url);
  if (existing) return existing;

  const promise = fetchInstagramMetaUncached(url)
    .then((internal): InstagramMetaResult => {
      const ttl = internal.status === 'transient_error' ? INSTAGRAM_TRANSIENT_TTL_MS : INSTAGRAM_META_TTL_MS;
      const result: InstagramMetaResult =
        internal.status === 'transient_error' ? { status: 'transient_error' } : internal;
      metaCache.set(url, { data: result, expiresAt: Date.now() + ttl });
      if (internal.status === 'transient_error' && internal.tripBreaker) {
        circuit.recordFailure();
      }
      return result;
    })
    .finally(() => {
      inflight.delete(url);
    });

  inflight.set(url, promise);
  return promise;
}
