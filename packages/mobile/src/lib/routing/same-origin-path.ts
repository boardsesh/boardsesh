// Will this path still name a page on our own origin once the router is done with it?
//
// Expo Router treats `//host/…` and `https://host/…` as external: `router.replace`
// and `<Redirect>` hand them to `Linking.openURL`, which on the browser export sets
// `window.location`. Looking at the string as it stands is not enough, because the
// router percent-decodes a path while it routes: once in `getStateFromPath` and
// again when it builds `usePathname()` (`decodeParams`). `/es/%252Fevil.example/x`
// is a harmless path until those two decodes turn it into `/es//evil.example/x`, and
// `+not-found` strips the locale off the front of that.
//
// So every layer the value can decode to has to pass, not just the one in hand.
// Pure and React-free, with no imports, so `+native-intent` can reach it at startup.

/**
 * Passes before a value counts as hostile. The router decodes twice per
 * navigation and legitimate links are encoded at most once, so an honest value
 * settles long before this; a value still changing here is built to outlast a
 * check.
 */
const MAX_DECODE_PASSES = 6;

/**
 * C0 control characters and DEL, by code point so the source carries no invisible
 * characters. Browsers strip tabs and newlines from anywhere in a URL, so `/\t/evil`
 * collapses into `//evil`.
 */
export function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const codePoint = text.charCodeAt(index);
    if (codePoint < 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}

/** Decode one segment as the router does: a malformed escape stays as it is. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Is this layer a same-origin path? An empty segment is refused anywhere in it, not
 * only at the front, because `stripLocalePrefix` can bring it to the front:
 * `/es//evil.example` is one strip away from `//evil.example`. A backslash counts as
 * a slash to the browser.
 */
function isSameOriginLayer(path: string): boolean {
  return path.startsWith('/') && !path.includes('//') && !path.includes('\\') && !hasControlCharacter(path);
}

/**
 * Is `href` a same-origin app path at every depth of percent-decoding?
 *
 * Only the path is judged. A query or fragment cannot move a URL to another origin,
 * and a real one can carry a URL of its own (`/share-beta?link=https%3A%2F%2F…`).
 * Spaces and any other printable text are fine: a setter's name can have a space in
 * it, and `usePathname()` hands it back decoded.
 */
export function isSameOriginPath(href: string | null | undefined): href is string {
  if (!href) return false;
  let layer = href.split(/[?#]/, 1)[0] ?? '';
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
    if (!isSameOriginLayer(layer)) return false;
    const decoded = layer.split('/').map(decodeSegment).join('/');
    if (decoded === layer) return true;
    layer = decoded;
  }
  return false;
}
