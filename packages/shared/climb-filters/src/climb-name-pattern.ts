/**
 * The LIKE pattern a typed climb-name search matches against `board_climbs.name`.
 *
 * One builder for both search paths, so they cannot drift: the backend's Postgres
 * `ILIKE` (`@boardsesh/db` create-climb-filters) and the offline SQLite `LIKE`
 * (`packages/mobile/src/db/queries/search-climbs-local.ts`). Both use `\` as the
 * escape character: Postgres by default, SQLite through an explicit
 * `ESCAPE '\'` on the predicate.
 *
 * A plain substring match missed climbs whose names differ from the query only
 * in punctuation (issue #5353). iOS Smart Punctuation turns a typed `'` into `’`,
 * and the catalogues use both forms. About 14k Kilter names use a curly
 * apostrophe and about 6k use a straight one, so either key missed some of them.
 * The builder therefore loosens three things and nothing else:
 *
 * - Every apostrophe or quote variant becomes `_` (any one character), so
 *   `Joey’s Gaston` and `Joey's Gaston` find each other.
 * - Every hyphen or dash variant becomes `_`, so `Spider–Man` finds `Spider-Man`.
 * - Every whitespace run becomes `%`, so `joey gaston` finds `Joey's Gaston` and a
 *   single space finds a name typed with two. Word order is kept.
 *
 * The user's own `\`, `%` and `_` are escaped first, so they still match
 * literally. `_` and `%` wildcards leave the `pg_trgm` GIN index on `name`
 * usable, because trigrams are still taken from the literal runs between them.
 *
 * Input with nothing but whitespace keeps the old literal pattern instead of
 * collapsing to `%%`, which would match every climb. The by-name exceptions
 * (hidden climbs, cross-angle Woods) key off a non-empty `name`, so matching
 * everything there would leak those climbs into an effectively unfiltered list.
 */

const APOSTROPHE_OR_QUOTE = /['"`´ʹʺʻʼʽ‘’‚‛“”„‟′″＇＂]/g;
const HYPHEN_OR_DASH = /[-‐‑‒–—―−﹘﹣－]/g;
const WHITESPACE_RUN = /\s+/g;

function escapeLikeMetacharacters(input: string): string {
  return input.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function climbNameLikePattern(query: string): string {
  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0) return `%${escapeLikeMetacharacters(query)}%`;
  const loosenedQuery = escapeLikeMetacharacters(trimmedQuery)
    .replace(APOSTROPHE_OR_QUOTE, '_')
    .replace(HYPHEN_OR_DASH, '_')
    .replace(WHITESPACE_RUN, '%');
  return `%${loosenedQuery}%`;
}
