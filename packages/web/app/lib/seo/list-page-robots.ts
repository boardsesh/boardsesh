// A board's /list route takes filter/sort query params (minGrade, sortBy,
// name, settername, ...). Without a robots override, every parameter
// combination a crawler stumbles onto (via internal links, referrers, or
// guessed query strings) is its own indexable page — an unbounded crawl
// space over what is really one page of content. `page` is exempt: plain
// pagination through the same filtered/unfiltered result set stays
// indexable.
const PAGINATION_ONLY_PARAM = 'page';

export type ListPageSearchParams = Record<string, string | string[] | undefined>;

/**
 * True when the raw query string carries a filter/sort param beyond simple
 * pagination. Prefer `resolveListPageIndexation` over calling this directly —
 * it is what turns the answer into the `path` + `robots` pair, identically on
 * both `/list` trees.
 */
export function hasListFilterParams(searchParams: ListPageSearchParams): boolean {
  return Object.entries(searchParams).some(([key, value]) => {
    if (key === PAGINATION_ONLY_PARAM) return false;
    if (value === undefined) return false;
    return Array.isArray(value) ? value.length > 0 : value !== '';
  });
}

/** Rows per `?page=N` on the `/list` front doors — the epic's ≥50-crawlable-links bar. */
export const FRONT_DOOR_PAGE_SIZE = 50;

/**
 * The last `?page` that stays indexable. Ten pages is 500 climbs — deep enough
 * that everything worth crawling on a board is reachable, shallow enough that
 * the tail of a six-figure catalog isn't thousands of thin near-duplicate
 * pages. Beyond it the page is `noindex, follow`: crawlers keep walking the
 * climb links, they just don't index the container.
 */
export const FRONT_DOOR_MAX_INDEXABLE_PAGE = 10;

/**
 * The `?page=N` a front door should render, 1-based. Anything unparseable,
 * missing or below 1 is page 1 — `?page=1` and the bare path are the same page,
 * which is why page 1 canonicalises to the path with no query.
 */
export function parseFrontDoorPage(rawPage: string | string[] | number | undefined): number {
  const first = Array.isArray(rawPage) ? rawPage[0] : rawPage;
  const parsed = Number(first);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.trunc(parsed));
}

/** True while `?page=N` is still worth indexing (1..FRONT_DOOR_MAX_INDEXABLE_PAGE). */
export function isIndexableFrontDoorPage(page: number): boolean {
  return page <= FRONT_DOOR_MAX_INDEXABLE_PAGE;
}

/** `?page=1` and the bare path are one URL, so page 1 keeps the query off. */
export function frontDoorPagePath(basePath: string, page: number): string {
  return page <= 1 ? basePath : `${basePath}?page=${page}`;
}

const NOINDEX_FOLLOW = { index: false, follow: true } as const;

export type ListPageIndexationInput = {
  /**
   * The canonical clean base path for this board config — the output of
   * `buildCanonicalClimbListUrl`, with no query string. Both trees pass the
   * config-tuple URL: `/b/{slug}` names a board a user owns, not a climb
   * config, so it is never the consolidation target (A1).
   */
  cleanPath: string;
  /** 1-based `?page=N`, already through `parseFrontDoorPage`. */
  page: number;
  searchParams: ListPageSearchParams;
  /**
   * The board itself must never be indexed — an unlisted or private `/b`
   * board. Distinct from "this query variant shouldn't be indexed".
   */
  boardIsHidden?: boolean;
};

export type ListPageIndexation = {
  /** Feed straight to `createPageMetadata`; `undefined` emits no `alternates`. */
  path: string | undefined;
  robots: typeof NOINDEX_FOLLOW | undefined;
};

/**
 * ONE indexation doctrine for both `/list` front doors. It lives here rather
 * than in the two pages because W-15 originally shipped two of them — the
 * config-tuple page canonicalised its filtered variants onto the clean base
 * while the `/b` twin dropped `alternates` entirely — and a canonical rule
 * that differs by tree is exactly the split A1 exists to close.
 *
 * The three cases, and why they differ:
 *
 * 1. **A hidden board** (`/b` unlisted or private) emits NO canonical. It is
 *    the one case where the noindex is about the board rather than about a
 *    query variant, and its clean base is a *public* config-tuple URL we do
 *    want indexed — a canonical from a noindex URL onto that twin is the
 *    conflicting signal Google can resolve by propagating the noindex.
 * 2. **Filter/sort variants** are the same page of content behind a different
 *    query, so they consolidate onto the clean base (CLAUDE.md's SEO rule:
 *    "Canonicalise filtered/sorted/paginated variants to the clean base URL")
 *    and drop out of the index themselves.
 * 3. **Pagination is self-canonical, always.** `?page=3` is different climbs,
 *    not a duplicate of page 1, so pointing its canonical at the base is the
 *    classic pagination anti-pattern. Past `FRONT_DOOR_MAX_INDEXABLE_PAGE` it
 *    goes `noindex, follow` but keeps canonicalising to itself — a self-
 *    canonical carries no conflicting signal.
 */
export function resolveListPageIndexation({
  cleanPath,
  page,
  searchParams,
  boardIsHidden = false,
}: ListPageIndexationInput): ListPageIndexation {
  if (boardIsHidden) return { path: undefined, robots: NOINDEX_FOLLOW };
  if (hasListFilterParams(searchParams)) return { path: cleanPath, robots: NOINDEX_FOLLOW };
  return {
    path: frontDoorPagePath(cleanPath, page),
    robots: isIndexableFrontDoorPage(page) ? undefined : NOINDEX_FOLLOW,
  };
}
