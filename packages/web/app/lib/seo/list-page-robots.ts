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
