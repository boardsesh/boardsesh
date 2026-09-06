import 'server-only';
import { unstable_cache } from 'next/cache';
import { sql, type SQL } from 'drizzle-orm';
import { toBoardName } from '@boardsesh/board-config';
import { withSerialPlan, type SerialPlanDb } from '@boardsesh/db/queries';
import { dbzRead } from '@/app/lib/db/db';
import { getAllBoardConfigsOrThrow } from '@/app/lib/server-popular-configs';
import { resolveClimbSitemapGroups, type ClimbConfigGroup } from './climb-entries';
import { latestLastModified, type SitemapItem } from './entries';
import { publishableAngleWhere } from './published-angle';
import { SETTER_MIN_VISIBLE_CLIMBS, SETTER_PAGE_SIZE } from './setter-page-contract';

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

/** In-process TTL for the full item list; matches the shard's CDN freshness window. */
const ITEMS_TTL_MS = 6 * 60 * 60 * 1000;
/** Same window for the summary, in front of the Data Cache (which does not dedupe misses). */
const SUMMARY_TTL_MS = 6 * 60 * 60 * 1000;
/** Next Data Cache window for the (small) summary the index reads on every hit. */
const SUMMARY_REVALIDATE_SECONDS = 21_600;
/**
 * A forward hook, not a live eviction path: nothing calls `revalidateTag` with
 * it yet, here or on the climbs shard.
 *
 * Whoever wires one up has to evict BOTH layers. `revalidateTag` clears the
 * Next Data Cache, but `cachedSummary` in front of it is an in-process TTL that
 * knows nothing about tags, so a tagged revalidation is invisible to this
 * instance for up to `SUMMARY_TTL_MS` (6 h) — the surface would keep serving
 * the old summary and look like the revalidation silently failed.
 */
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
 * Encoding itself cannot fail here: `encodeURIComponent` throws only on a lone
 * surrogate, and Postgres `text` in a UTF-8 database cannot hold one. The item
 * builder still checks — and refuses to cache when a check fires — because
 * "unreachable" is a claim about the database, not a guarantee from this file.
 */
const routableUsername = sql`
  setter_username IS NOT NULL
  AND setter_username <> ''
  AND setter_username ~ '^\\S(.*\\S)?$'
  AND setter_username !~ '[/?#]'
  AND setter_username !~ '[\\x00-\\x1F\\x7F\\x80-\\x9F]'
  AND setter_username !~ '^[.]{1,2}$'
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
  // Guarded here rather than only in the caller: with no groups the `OR` list
  // renders as a bare `()` and the statement is a syntax error at the database,
  // which is a far worse way to learn the catalogue is empty. No resolvable
  // group means no climb on this site has a canonical URL at all.
  if (groups.length === 0) {
    throw new Error('[sitemap] setters shard: no resolvable board configuration — refusing to build an empty shard');
  }

  const linkable = sql.join(
    groups.map((group) => groupPredicate(group)),
    sql` OR `,
  );

  // Every VISIBLE climb, not just the linkable ones, because two of the three
  // things this query decides are properties of the rendered page rather than
  // of the submitted subset: where a climb lands in page one's ordering, and
  // when the page last changed.
  //
  // `page_rank_ascents` reproduces the page's sort key. The page joins stats at
  // `mostAscendedAngle` and orders on `COALESCE(stats.ascensionist_count, 0)
  // DESC, uuid`; that angle is chosen by `ascensionist_count desc nulls last`
  // over publishable angles, so the value it lands on IS the max over those
  // angles. `max()` skipping nulls is the same "nulls last". Taking the max
  // directly costs one aggregate instead of a correlated LIMIT 1 per row.
  return sql`
    WITH visible AS (
      SELECT
        board_climbs.setter_username AS setter_username,
        board_climbs.uuid AS uuid,
        (${linkable}) AS is_linkable,
        GREATEST(
          board_climbs.updated_at,
          COALESCE(stats.newest_stats_at, board_climbs.updated_at)
        ) AS content_clock,
        COALESCE(stats.top_ascents, 0) AS page_rank_ascents
      FROM board_climbs
      LEFT JOIN LATERAL (
        SELECT
          max(candidate.ascensionist_count) AS top_ascents,
          max(candidate.updated_at) AS newest_stats_at
        FROM board_climb_stats candidate
        WHERE candidate.board_type = board_climbs.board_type
          AND candidate.climb_uuid = board_climbs.uuid
          AND ${publishableAngleWhere(sql`candidate.angle`, sql`board_climbs.board_type`)}
      ) AS stats ON true
      WHERE board_climbs.is_listed = true
        AND board_climbs.is_draft = false
        AND ${routableUsername}
    ),
    ranked AS (
      SELECT
        setter_username,
        is_linkable,
        content_clock,
        row_number() OVER (
          PARTITION BY setter_username
          ORDER BY page_rank_ascents DESC, uuid
        ) AS page_position
      FROM visible
    )
    SELECT
      setter_username,
      to_char(max(content_clock), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_modified
    FROM ranked
    GROUP BY setter_username
    HAVING count(*) FILTER (WHERE is_linkable) >= ${SETTER_MIN_VISIBLE_CLIMBS}
       AND count(*) FILTER (WHERE is_linkable AND page_position <= ${SETTER_PAGE_SIZE}) >= 1
    ORDER BY setter_username ASC
  `;
}

export type SetterSitemapQueryRow = {
  setter_username: string;
  last_modified: string | null;
};

export function runSetterSitemapQuery(db: SerialPlanDb, groups: readonly ClimbConfigGroup[]) {
  return db.execute<SetterSitemapQueryRow>(buildSetterSitemapSql(groups));
}

async function fetchSetterRows(): Promise<SetterSitemapQueryRow[]> {
  // A catalogue failure rather than "no setters qualify" — publishing an empty
  // shard there would tell Google the whole surface was deleted. The throw lives
  // in `buildSetterSitemapSql`, so the seam and this path fail identically.
  const groups = resolveClimbSitemapGroups(await getAllBoardConfigsOrThrow());

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
    let encoded: string;
    try {
      encoded = encodeURIComponent(row.setter_username);
      if (decodeURIComponent(encoded) !== row.setter_username) {
        dropped += 1;
        continue;
      }
    } catch {
      // `encodeURIComponent` throws on a lone surrogate. Postgres `text` in a
      // UTF-8 database cannot hold one, so this is unreachable from the real
      // query — but "unreachable" is a claim about the database, and it must
      // not become a 500 on the sitemap route if it is ever wrong.
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

/**
 * Deliberately not a `COUNT(*)`, unlike the climbs summary — it reads the length
 * of the very list the pages will slice.
 *
 * The climbs summary can count in SQL because its item builder drops nothing the
 * query cannot also express. This one has to agree with `setterRowsToItems`
 * after the round-trip check, and a count that disagrees by one turns the last
 * page into a 503.
 *
 * It calls `buildSetterSitemapItems` rather than repeating `fetchSetterRows`,
 * which is what makes that agreement structural rather than a convention: the
 * two share one in-process single-flight, so a cold burst — `/sitemap.xml` and
 * `/sitemaps/setters/1.xml` arriving together, the #4461 shape — runs ONE
 * grouped scan on that instance instead of two in parallel. The Data Cache still
 * stores only the two small values, which is what the index reads on every hit.
 */
const cachedSetterSummary = unstable_cache(
  async (): Promise<{ itemCount: number; lastModifiedIso: string | null }> => {
    const items = await buildSetterSitemapItems();
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
      // A drop is unreachable by construction — the SQL predicate rejects
      // everything the round-trip check could — so one means the two rules have
      // disagreed and the item list no longer matches the summary that sized the
      // pages. Throwing 503s the page and retries; caching the short list
      // instead would serve a wrong or empty shard for the full six-hour TTL
      // behind a single `console.warn` nobody reads.
      if (dropped > 0) {
        throw new Error(
          `[sitemap] setters shard dropped ${dropped} of ${dropped + items.length} usernames the SQL predicate should have excluded — refusing to cache a list the summary does not describe`,
        );
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
