/**
 * Whether `/setter/{name}` is a URL a crawler can actually reach.
 *
 * The same five rules the setter sitemap selects names by (`routableUsername`
 * in `sitemap/setter-query.ts`, which explains each one). That copy is SQL so
 * the sitemap's summary and item list select one set; this copy is for code that
 * links a setter page from elsewhere, such as the climb JSON-LD's `author.url`.
 * Change one and change the other.
 *
 *  1. No leading or trailing whitespace: proxies strip the `%20`.
 *  2. No `/`, `?` or `#`: they end or split the path at the first early decode.
 *  3. No control characters (C0, DEL, C1).
 *  4. No Unicode whitespace or zero-width characters anywhere.
 *  5. Not `.` or `..`, which URL normalisation eats.
 *
 * Plus the sitemap item builder's round trip: the name must survive
 * `encodeURIComponent` and come back unchanged.
 */
const PADDED = /^\s|\s$/;
const PATH_BREAKING = /[/?#]/;
const DOT_SEGMENT = /^\.{1,2}$/;

/** Rule 4's characters, as code points: no-break, ogham, the U+2000 block through zero-width, separators, BOM. */
const INVISIBLE_SPACES: ReadonlySet<number> = new Set([0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]);
const SPACE_BLOCK_START = 0x2000;
const ZERO_WIDTH_SPACE = 0x200b;

/** Rules 3 and 4, which are about code points rather than patterns. */
function hasUnroutableCharacter(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    const isControl = codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    const isInvisibleSpace =
      INVISIBLE_SPACES.has(codePoint) || (codePoint >= SPACE_BLOCK_START && codePoint <= ZERO_WIDTH_SPACE);
    if (isControl || isInvisibleSpace) return true;
  }
  return false;
}

export function isRoutableSetterUsername(username: string): boolean {
  if (
    !username ||
    PADDED.test(username) ||
    PATH_BREAKING.test(username) ||
    DOT_SEGMENT.test(username) ||
    hasUnroutableCharacter(username)
  ) {
    return false;
  }
  try {
    return decodeURIComponent(encodeURIComponent(username)) === username;
  } catch {
    // A lone surrogate: `encodeURIComponent` throws on it.
    return false;
  }
}
