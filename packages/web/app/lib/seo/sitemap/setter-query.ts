import 'server-only';
import { unstable_cache } from 'next/cache';
import { sql, type SQL } from 'drizzle-orm';
import { toBoardName } from '@boardsesh/board-config';
import { withSerialPlan, type SerialPlanDb } from '@boardsesh/db/queries';
import { dbzRead } from '@/app/lib/db/db';
import { getAllBoardConfigsOrThrow } from '@/app/lib/server-popular-configs';
import { resolveClimbSitemapGroups, type ClimbConfigGroup } from './climb-entries';
import { latestLastModified, type SitemapItem } from './entries';

/**
 * How many publicly visible climbs a setter needs before their page is worth a
 * crawl budget.
 *
 * The same judgement the climbs shard already makes one level down, where tier 2
 * is "a climb somebody has actually done" (`TIER_2_MIN_ASCENTS = 10`) and tier 3
 * is held back until Search Console shows healthy coverage. A one- or two-climb
 * setter page is thin by construction. The page still serves 200 at one visible
 * climb on any board — this gate decides what we *push*, not what exists.
 */
export const SETTER_MIN_VISIBLE_CLIMBS = 3;

/** In-process TTL for the full item list; matches the shard's CDN freshness window. */
const ITEMS_TTL_MS = 6 * 60 * 60 * 1000;
/** Same window for the summary, in front of the Data Cache (which does not dedupe misses). */
const SUMMARY_TTL_MS = 6 * 60 * 60 * 1000;
/** Next Data Cache window for the (small) summary the index reads on every hit. */
const SUMMARY_REVALIDATE_SECONDS = 21_600;
const SUMMARY_CACHE_TAG = 'sitemap-setters';

export type SetterSitemapSummary = { itemCount: number; lastModified: Date | null };

function setIdArray(setIds: readonly number[]) {
  return sql`ARRAY[${sql.join(
    setIds.map((id) => sql`${id}`),
    sql`, `,
  )}]::int[]`;
}

/**
 * A climb that renders on ONE configuration the climbs sitemap resolves.
 *
 * Same three predicates `buildChosenSubquery` applies before the climbs shard
 * will name a config in a climb's URL — board/layout, `@>` size containment and
 * `<@` set containment, with MoonBoard exempt from the size half because it has
 * one fixed size and never populates `compatible_size_ids`.
 *
 * This is what makes the gate *linkable* rather than merely non-empty: a setter
 * whose climbs are all on a layout no group resolves would get a page with an
 * `<h1>` over a list of rows carrying no crawlable link at all.
 */
function groupPredicate(group: ClimbConfigGroup): SQL {
  const isMoonboard = toBoardName(group.boardType) === 'moonboard';

  const parts: SQL[] = [sql`board_type = ${group.boardType}`, sql`layout_id = ${group.layoutId}`];

  if (!isMoonboard) {
    parts.push(sql`compatible_size_ids @> ARRAY[${group.sizeId}]::int[]`);
  }

  if (group.setIds.length > 0) {
    parts.push(
      isMoonboard
        ? sql`(required_set_ids IS NULL OR required_set_ids <@ ${setIdArray(group.setIds)})`
        : sql`required_set_ids <@ ${setIdArray(group.setIds)}`,
    );
  }

  return sql`(${sql.join(parts, sql` AND `)})`;
}

/**
 * Usernames whose `/setter/{name}` URL a crawler cannot normalise into a 404.
 *
 * Three rules, all in SQL rather than in JavaScript after the fact, because the
 * summary and the item list have to select the identical set — a JS-side filter
 * would let the summary advertise a page the item build cannot fill, which the
 * paged handler turns into a 503.
 *
 *  1. **No leading or trailing whitespace.** Those encode to a leading/trailing
 *     `%20` that crawlers and proxies routinely strip, landing on a name nobody
 *     set a climb under. `\S` covers every whitespace class, not just spaces.
 *  2. **No `/`, `?` or `#`.** A `%2F` inside a Next dynamic segment is not
 *     reliably routable, and `?`/`#` terminate the path at the first hop that
 *     decodes early.
 *  3. **No C0/C7F control characters**, which no HTTP intermediary agrees on.
 *
 * `encodeURIComponent` itself cannot throw here: Postgres `text` in a UTF-8
 * database cannot hold a lone surrogate, so the round-trip is total. The item
 * builder still checks and warns — see `buildSetterSitemapItems`.
 */
const routableUsername = sql`
  setter_username IS NOT NULL
  AND setter_username <> ''
  AND setter_username ~ '^\\S(.*\\S)?$'
  AND setter_username !~ '[/?#]'
  AND setter_username !~ '[\\x00-\\x1F\\x7F]'
`;

/**
 * The setters worth submitting, one row each, with the newest content clock
 * across their visible climbs.
 *
 * Split out as a `.toSQL()`-inspectable seam — the same seam `buildTier2ClimbQuery`
 * establishes — so a test renders the predicate this really runs.
 *
 * `board_setter_stats` is deliberately NOT the source. `buildRecomputeSetterStatsSql`
 * INNER JOINs `board_climb_stats`, so a setter whose climbs carry no stats row is
 * simply absent from that table, and its `updated_at` is `now()` at nightly
 * refresh — a job clock. Publishing that as `<lastmod>` would claim every setter
 * changed every night, which is the exact signal destruction `entries.ts` forbids.
 */
export function buildSetterSitemapSql(groups: readonly ClimbConfigGroup[]): SQL {
  const linkable = sql.join(
    groups.map((group) => groupPredicate(group)),
    sql` OR `,
  );

  return sql`
    SELECT
      setter_username,
      count(*)::int AS climb_count,
      to_char(max(updated_at), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_modified
    FROM board_climbs
    WHERE is_listed = true
      AND is_draft = false
      AND ${routableUsername}
      AND (${linkable})
    GROUP BY setter_username
    HAVING count(*) >= ${SETTER_MIN_VISIBLE_CLIMBS}
    ORDER BY setter_username ASC
  `;
}

export type SetterSitemapQueryRow = {
  setter_username: string;
  climb_count: number;
  last_modified: string | null;
};

export function runSetterSitemapQuery(db: SerialPlanDb, groups: readonly ClimbConfigGroup[]) {
  return db.execute<SetterSitemapQueryRow>(buildSetterSitemapSql(groups));
}

async function fetchSetterRows(): Promise<SetterSitemapQueryRow[]> {
  const groups = resolveClimbSitemapGroups(await getAllBoardConfigsOrThrow());

  // No resolvable group means no climb on this site has a canonical URL, which
  // is a catalogue failure rather than "no setters qualify". Publishing an empty
  // shard there would tell Google the whole surface was deleted.
  if (groups.length === 0) {
    throw new Error('[sitemap] setters shard: no resolvable board configuration — refusing to build an empty shard');
  }

  return [...(await withSerialPlan(dbzRead, async (tx) => runSetterSitemapQuery(tx, groups)))];
}

/**
 * Rows → sitemap items.
 *
 * The `<lastmod>` is the row's own clock, parsed from the explicit-`Z` string
 * the query renders. `to_char` rather than a bare timestamp aggregate because
 * the raw `sql` fragment bypasses drizzle's timestamp mapper, so the driver
 * otherwise hands back pg text like `2026-08-10 20:39:19.492` that `new Date()`
 * reads in the PROCESS timezone. A `new Date()` here would claim every setter
 * changed on every crawl.
 *
 * The round-trip check is defence in depth, not the selection rule: the SQL
 * predicate above already excludes everything it can reject. A non-zero drop
 * count means a username reached here that the SQL was supposed to have
 * filtered, and it must be loud — a silent drop desynchronises the item list
 * from the summary that sized the pages.
 */
export function setterRowsToItems(rows: readonly SetterSitemapQueryRow[]): {
  items: SitemapItem[];
  dropped: number;
} {
  const items: SitemapItem[] = [];
  let dropped = 0;

  for (const row of rows) {
    const encoded = encodeURIComponent(row.setter_username);
    if (decodeURIComponent(encoded) !== row.setter_username) {
      dropped += 1;
      continue;
    }
    items.push({
      path: `/setter/${encoded}`,
      lastModified: row.last_modified ? new Date(row.last_modified) : null,
    });
  }

  return { items, dropped };
}

const cachedSetterSummary = unstable_cache(
  async (): Promise<{ itemCount: number; lastModifiedIso: string | null }> => {
    // Built through the SAME item builder the pages serve, so the count the
    // index publishes and the list the pages slice can never describe different
    // sets — including the round-trip drop, which would otherwise leave the
    // summary advertising a page the build cannot fill.
    const { items } = setterRowsToItems(await fetchSetterRows());
    const lastModified = latestLastModified(items);

    return { itemCount: items.length, lastModifiedIso: lastModified ? lastModified.toISOString() : null };
  },
  ['sitemap-setters-summary'],
  { revalidate: SUMMARY_REVALIDATE_SECONDS, tags: [SUMMARY_CACHE_TAG] },
);

let cachedSummary: { builtAt: number; summary: SetterSitemapSummary } | null = null;
let summaryInFlight: Promise<SetterSitemapSummary> | null = null;

/**
 * The setter count and freshness, behind the SAME in-process TTL + single-flight
 * the item build gets.
 *
 * `unstable_cache` alone is not enough: it does not deduplicate concurrent
 * misses, and on a cold Data Cache a crawl burst is `/sitemap.xml` plus every
 * `/sitemaps/setters/N.xml` page arriving together, each calling this. Without
 * the single-flight that is one full grouped scan per request against a
 * ten-connection pool, which is #4461 exactly.
 */
export async function fetchSetterSitemapSummary(): Promise<SetterSitemapSummary> {
  if (cachedSummary && Date.now() - cachedSummary.builtAt < SUMMARY_TTL_MS) {
    return cachedSummary.summary;
  }
  if (summaryInFlight) {
    return summaryInFlight;
  }

  const build = (async () => {
    const { itemCount, lastModifiedIso } = await cachedSetterSummary();
    const summary: SetterSitemapSummary = {
      itemCount,
      lastModified: lastModifiedIso ? new Date(lastModifiedIso) : null,
    };
    cachedSummary = { builtAt: Date.now(), summary };
    return summary;
  })();
  summaryInFlight = build;

  try {
    return await build;
  } finally {
    summaryInFlight = null;
  }
}

let cachedItems: { builtAt: number; items: SitemapItem[] } | null = null;
let itemsInFlight: Promise<SitemapItem[]> | null = null;

/**
 * The full ordered item list, behind a 6-hour TTL and a single-flight promise.
 *
 * Not in the Next Data Cache, and for the same reason the climb items are not:
 * a crawl burst across N pages on N cold lambdas really does cost N builds, and
 * per-page cache entries would not help because building page N still needs the
 * whole ordered list before it can slice. This is a per-instance defence.
 */
export async function buildSetterSitemapItems(): Promise<SitemapItem[]> {
  if (cachedItems && Date.now() - cachedItems.builtAt < ITEMS_TTL_MS) {
    return cachedItems.items;
  }
  if (itemsInFlight) {
    return itemsInFlight;
  }

  const build = fetchSetterRows()
    .then((rows) => setterRowsToItems(rows))
    .then(({ items, dropped }) => {
      if (dropped > 0) {
        console.warn(`[sitemap] setters shard dropped ${dropped} usernames the SQL predicate should have excluded.`);
      }
      cachedItems = { builtAt: Date.now(), items };
      return items;
    });
  itemsInFlight = build;

  try {
    return await build;
  } finally {
    itemsInFlight = null;
  }
}

/** Test seam: drops the in-process TTL caches. */
export function resetSetterSitemapCachesForTests(): void {
  cachedItems = null;
  itemsInFlight = null;
  cachedSummary = null;
  summaryInFlight = null;
}
