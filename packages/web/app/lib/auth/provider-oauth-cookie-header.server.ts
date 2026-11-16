import 'server-only';

/** The raw, undecoded request path of a Google or Apple sign-in start or callback. */
const PROVIDER_OAUTH_PATH = /^\/api\/auth\/(?:signin|callback)\/(?:google|apple)(?:\/|$)/;
const MAX_COOKIE_HEADER_BYTES = 32_768;
const MAX_COOKIE_HEADER_SEGMENTS = 128;

/**
 * A Google or Apple sign-in start or callback, named either by the raw path or
 * by the decoded catch-all segments NextAuth dispatches on (`%67oogle`).
 */
export function isProviderOAuthRequest(pathname: string, route: readonly string[]): boolean {
  const [action, provider] = route;
  return (
    PROVIDER_OAUTH_PATH.test(pathname) ||
    ((action === 'signin' || action === 'callback') && (provider === 'google' || provider === 'apple'))
  );
}

/**
 * The Cookie header rules the Google and Apple routes have enforced since
 * #7526: at most 32 KiB, at most 128 `;`-separated segments, no control
 * character other than tab, and every non-blank segment a `name=value` pair
 * whose `=` is not its first character. A missing or empty header passes.
 */
export function isAcceptableProviderOAuthCookieHeader(header: string | null): boolean {
  if (!header) return true;
  if (Buffer.byteLength(header) > MAX_COOKIE_HEADER_BYTES) return false;
  for (let index = 0; index < header.length; index++) {
    const code = header.charCodeAt(index);
    if ((code < 32 && code !== 9) || code === 127) return false;
  }
  const segments = header.split(';');
  if (segments.length > MAX_COOKIE_HEADER_SEGMENTS) return false;
  return segments.every((segment) => !segment.trim() || segment.indexOf('=') > 0);
}
