/**
 * The viewer marker (#7596, decision "how the guard learns of an account switch
 * on another host"): a readable, non-secret cookie written beside the
 * first-party session cookie, so a page can tell synchronously, when a reply
 * lands, whether the browser still holds the login it shows.
 *
 * Value: the first 16 characters of
 * `base64url(sha256("boardsesh-viewer-v1:" + authSessionId))`. It is not the
 * session token, and it cannot be turned back into the id. The server never
 * reads it; it carries no authority. Only the session-cookie builders in
 * `browser-session-cookie.ts` write and clear it.
 *
 * Browser-safe: WebCrypto and `document.cookie` text only, no `node:crypto`.
 * Import it through `@boardsesh/auth-protocol/viewer-marker` only; the package
 * root never re-exports it, and native code never imports it (boundary test).
 */

const VIEWER_MARKER_BASE_NAME = 'boardsesh.viewer';
const SECURE_COOKIE_PREFIX = '__Secure-';

/** The digest input's prefix. A new version of the value gets a new prefix. */
export const VIEWER_MARKER_DIGEST_PREFIX = 'boardsesh-viewer-v1:';

/** Characters of the base64url digest the cookie keeps: 96 bits. */
export const VIEWER_MARKER_VALUE_LENGTH = 16;

/** `__Secure-boardsesh.viewer` in a secure context, `boardsesh.viewer` on local http: the session cookie names' rule. */
export function viewerMarkerCookieName(secure: boolean): string {
  return secure ? `${SECURE_COOKIE_PREFIX}${VIEWER_MARKER_BASE_NAME}` : VIEWER_MARKER_BASE_NAME;
}

/** The exact text hashed for a login. */
export function viewerMarkerDigestInput(authSessionId: string): string {
  return `${VIEWER_MARKER_DIGEST_PREFIX}${authSessionId}`;
}

/** The marker from a SHA-256 digest of `viewerMarkerDigestInput`: its base64url, cut to 16 characters. */
export function viewerMarkerFromDigest(digest: ArrayBuffer | Uint8Array): string {
  const bytes = digest instanceof Uint8Array ? digest : new Uint8Array(digest);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, VIEWER_MARKER_VALUE_LENGTH);
}

/**
 * The marker a page expects for its accepted login, through WebCrypto.
 * Undefined when WebCrypto is missing (an insecure context) or the digest
 * fails: the page then does no marker check.
 */
export async function computeViewerMarker(
  authSessionId: string,
  subtle: SubtleCrypto | null = globalThis.crypto?.subtle ?? null,
): Promise<string | undefined> {
  if (!authSessionId || !subtle) return undefined;
  try {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(viewerMarkerDigestInput(authSessionId)));
    return viewerMarkerFromDigest(digest);
  } catch {
    return undefined;
  }
}

/**
 * What `document.cookie` says about the marker:
 * - `missing`: no copy under the context's name;
 * - `conflicted`: two copies (Domain and host-only) with differing values;
 * - `present`: one value, or several identical copies. A malformed value is
 *   reported as it is; it matches no login.
 */
export type ViewerMarkerReading =
  | { readonly kind: 'missing' }
  | { readonly kind: 'conflicted' }
  | { readonly kind: 'present'; readonly value: string };

/** Reads the marker for the context's name out of a `document.cookie` string. Never throws. */
export function readViewerMarker(documentCookie: string, secure: boolean): ViewerMarkerReading {
  const name = viewerMarkerCookieName(secure);
  const values = new Set<string>();
  for (const pair of documentCookie.split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() !== name) continue;
    values.add(pair.slice(separator + 1).trim());
  }
  if (values.size === 0) return { kind: 'missing' };
  if (values.size > 1) return { kind: 'conflicted' };
  const [value] = values;
  return value === undefined ? { kind: 'missing' } : { kind: 'present', value };
}
