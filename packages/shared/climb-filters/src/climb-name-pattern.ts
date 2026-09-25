/**
 * The LIKE pattern a typed climb-name search matches against a climb name.
 *
 * One builder for every climb-name search, so they cannot drift: climb search
 * (Postgres `ILIKE` in `@boardsesh/db` create-climb-filters), its offline SQLite
 * twin (`LIKE` in `packages/mobile/src/db/queries/search-climbs-local.ts`), and
 * the logbook's `climbName` filter (`packages/backend` ticks queries). All of
 * them escape with `\`: Postgres by default, SQLite through an explicit
 * `ESCAPE '\'` on the predicate.
 *
 * A plain substring match missed climbs whose names differ from the query only
 * in punctuation (issue #5353). iOS Smart Punctuation turns a typed `'` into `’`,
 * and the catalogues use both forms. About 14k Kilter names use a curly
 * apostrophe and about 6k use a straight one, so either key missed some of them.
 * The builder therefore loosens two things and nothing else:
 *
 * - Every apostrophe or quote variant becomes `_` (any one character), so
 *   `Joey’s Gaston` and `Joey's Gaston` find each other.
 * - Every hyphen or dash variant becomes `_`, so `Spider–Man` finds `Spider-Man`.
 *
 * Spaces stay literal. Folding them to `%` would let `the end` match any name
 * with "the" somewhere before "end". On the Kilter catalogue that more than
 * doubles the rows and pushes the climb actually named "The End" from rank 19 to
 * rank 51, off the first page. That is the irrelevant-results trade #5655 rules
 * out.
 *
 * The user's own `\`, `%` and `_` are escaped first, so they still match
 * literally. `_` wildcards leave the `pg_trgm` GIN index on `name` usable,
 * because trigrams are still taken from the literal runs between them.
 *
 * A query with nothing left to match once the folds are applied keeps the old
 * literal pattern: only whitespace, or only punctuation that folds (`'`, `-`,
 * an iOS opening `“`). Otherwise it would become `%_%`, which matches every
 * name. A non-empty `name` also turns on the by-name exceptions (hidden climbs,
 * Woods cross-angle), so matching everything there would leak those climbs into
 * an effectively unfiltered list.
 */

const APOSTROPHE_OR_QUOTE = /['"`´ʹʺʻʼʽ‘’‚‛“”„‟′″＇＂]/g;
const HYPHEN_OR_DASH = /[-‐‑‒–—―−﹘﹣－]/g;

function escapeLikeMetacharacters(input: string): string {
  return input.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** True when the query has at least one character the folds leave literal (spaces aside). */
function hasLiteralContent(query: string): boolean {
  return query.replace(APOSTROPHE_OR_QUOTE, '').replace(HYPHEN_OR_DASH, '').trim().length > 0;
}

export function climbNameLikePattern(query: string): string {
  const trimmedQuery = query.trim();
  if (!hasLiteralContent(trimmedQuery)) return `%${escapeLikeMetacharacters(query)}%`;
  const foldedQuery = escapeLikeMetacharacters(trimmedQuery)
    .replace(APOSTROPHE_OR_QUOTE, '_')
    .replace(HYPHEN_OR_DASH, '_');
  return `%${foldedQuery}%`;
}
