/**
 * The viewer marker on Expo web (#7596 decision, "how the guard learns of an
 * account switch on another host"): the browser's copy of
 * `@boardsesh/auth-protocol/viewer-marker`. The app package does not depend on
 * auth-protocol, and adding it would change a file that ships to phones, so
 * this `.web` file carries the three pieces the guard needs. Its test holds it
 * to the same value vector as the shared module and the server.
 *
 * Name: `__Secure-boardsesh.viewer` on https, `boardsesh.viewer` on local http.
 * Value: the first 16 characters of
 * `base64url(sha256("boardsesh-viewer-v1:" + authSessionId))`.
 * On a preview or locally the marker is host-only on www, so this page never
 * sees it and the check stays off.
 */

const VIEWER_MARKER_BASE_NAME = 'boardsesh.viewer';
const VIEWER_MARKER_DIGEST_PREFIX = 'boardsesh-viewer-v1:';
const VIEWER_MARKER_VALUE_LENGTH = 16;

export function viewerMarkerCookieName(secure: boolean): string {
  return secure ? `__Secure-${VIEWER_MARKER_BASE_NAME}` : VIEWER_MARKER_BASE_NAME;
}

/** The marker for a login, through WebCrypto; undefined without it or when the digest fails. */
export async function computeViewerMarker(authSessionId: string): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (!authSessionId || !subtle) return undefined;
  try {
    const digest = new Uint8Array(
      await subtle.digest('SHA-256', new TextEncoder().encode(`${VIEWER_MARKER_DIGEST_PREFIX}${authSessionId}`)),
    );
    let binary = '';
    for (const byte of digest) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, VIEWER_MARKER_VALUE_LENGTH);
  } catch {
    return undefined;
  }
}

export type ViewerMarkerReading =
  | { readonly kind: 'missing' }
  | { readonly kind: 'conflicted' }
  | { readonly kind: 'present'; readonly value: string };

/** The marker in `document.cookie` for the page's scheme. Never throws. */
export function readViewerMarker(documentCookie: string, secure: boolean): ViewerMarkerReading {
  const name = viewerMarkerCookieName(secure);
  const values = new Set<string>();
  for (const pair of documentCookie.split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1 || pair.slice(0, separator).trim() !== name) continue;
    values.add(pair.slice(separator + 1).trim());
  }
  if (values.size === 0) return { kind: 'missing' };
  if (values.size > 1) return { kind: 'conflicted' };
  const [value] = values;
  return value === undefined ? { kind: 'missing' } : { kind: 'present', value };
}
