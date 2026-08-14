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
 * pagination. Callers should respond by pointing `robots` at
 * `{ index: false, follow: true }` and `alternates.canonical` at the clean
 * base URL (no query string).
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
