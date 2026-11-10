const FALLBACK_PATH = '/';

// A hostname that cannot exist (RFC 2606). Only used to ask the URL parser where
// a browser would send a relative path.
const PARSING_ORIGIN = 'https://callback-url.invalid';

// Browsers strip tabs and newlines from a URL before parsing it, so `/<tab>/host`
// becomes `//host`. No return path we generate contains a control character.
const CONTROL_CHARACTER = /\p{Cc}/u;

// Only an ASCII byte can spell a slash, a backslash or a control character.
// Leaving the rest encoded keeps UTF-8 slugs and a stray `%` out of it.
const ENCODED_ASCII_BYTE = /%([0-7][0-9a-f])/gi;

// Real return paths are encoded once or twice. A value still changing after this
// many rounds is not one of ours.
const MAX_DECODE_ROUNDS = 8;

function decodeAsciiBytes(path: string): string {
  return path.replace(ENCODED_ASCII_BYTE, (_encodedByte, hexByte: string) =>
    String.fromCharCode(Number.parseInt(hexByte, 16)),
  );
}

// No return path we generate has an empty segment, and `//` is unsafe anywhere
// in the path: the locale router strips a leading locale, so `/es//host` would
// come out of it as `//host`. Checked on the parsed path so `/.//host`,
// `/es/\host` and the like are seen in the form a browser would use.
function hasDoubleSlashInPath(parsedUrl: URL): boolean {
  return parsedUrl.pathname.includes('//');
}

function staysOnSite(relativePath: string): boolean {
  if (CONTROL_CHARACTER.test(relativePath)) return false;
  try {
    const parsedUrl = new URL(relativePath, PARSING_ORIGIN);
    return parsedUrl.origin === PARSING_ORIGIN && !hasDoubleSlashInPath(parsedUrl);
  } catch {
    return false;
  }
}

function isSafeRelativePath(candidate: string): boolean {
  if (candidate[0] !== '/' || !staysOnSite(candidate)) return false;
  // The path only: a query or fragment can legitimately carry an encoded URL.
  let decodedPath = candidate.split(/[?#]/, 1)[0];
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    const nextPath = decodeAsciiBytes(decodedPath);
    if (nextPath === decodedPath) return true;
    if (!staysOnSite(nextPath)) return false;
    decodedPath = nextPath;
  }
  return false;
}

function sameOriginAbsoluteUrl(candidate: string, currentOrigin: string | undefined): string | null {
  if (!currentOrigin || CONTROL_CHARACTER.test(candidate)) return null;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(candidate);
  } catch {
    return null;
  }
  // `blob:https://host/id` reports the origin of the URL inside it.
  const isWebUrl = parsedUrl.protocol === 'https:' || parsedUrl.protocol === 'http:';
  if (!isWebUrl || parsedUrl.origin !== currentOrigin || parsedUrl.username || parsedUrl.password) return null;
  if (hasDoubleSlashInPath(parsedUrl)) return null;
  return parsedUrl.href;
}

/**
 * Reduce a `?callbackUrl=` value to somewhere safe to send the browser, so a
 * crafted value can never turn a redirect into an open redirect.
 *
 * A path beginning with a single `/` is honoured unless it would resolve
 * off-site or has `//` in its path: as written, once a browser has stripped its
 * tabs and newlines, or after any amount of percent-decoding. Anything else
 * (absolute URLs, `javascript:` and other schemes, protocol-relative `//host`,
 * the backslash variant `/\host`) falls back to the app root.
 *
 * Pass `currentOrigin` to also accept an absolute URL on exactly that origin,
 * because NextAuth always sends the login page an absolute `callbackUrl`. It
 * comes back absolute, so it can never be reinterpreted as a relative path, and
 * the same `//` rule applies to it.
 */
export function safeCallbackUrl(rawCallbackUrl: string | null | undefined, currentOrigin?: string): string {
  if (!rawCallbackUrl) return FALLBACK_PATH;
  if (isSafeRelativePath(rawCallbackUrl)) return rawCallbackUrl;
  return sameOriginAbsoluteUrl(rawCallbackUrl, currentOrigin) ?? FALLBACK_PATH;
}
