import 'server-only';
import * as Sentry from '@sentry/nextjs';
import { and, asc, eq } from 'drizzle-orm';
import {
  planTier2Pages,
  tier2PredicateFingerprint,
  verifyTier2Table,
  type Tier2GroupRow,
  type Tier2Verdict,
} from '@boardsesh/db/queries';
import { dbzRead } from '@/app/lib/db/db';
import { sitemapTier2Climbs, sitemapTier2Groups } from '@/app/lib/db/schema';
import { getAllBoardConfigsOrThrow } from '@/app/lib/server-popular-configs';
import { climbRowsToItems, isResolvableGroup, resolveClimbSitemapGroups } from './climb-entries';
import type { Tier2Summary } from './climb-query';
import type { SitemapItem } from './entries';

/**
 * The materialised read path for the climbs shard (#4583).
 *
 * `/sitemaps/climbs/N.xml` used to build the ENTIRE ordered tier-2 list before it
 * could slice page N — sixteen sequential `DISTINCT ON` scans, measured at 27.4 s
 * for a genuinely cold production page fetch on 2026-08-21, and paid again per
 * cold lambda. Here page N is a PK-prefix range scan of at most 10,000 rows.
 *
 * The live path is kept, not deleted, and is what runs when these tables cannot
 * be trusted. The whole lesson of #4583 is that a quiet degrade hid a real
 * regression, so a fallback is never quiet: it fires a Sentry event and it names
 * itself on the response through `X-Sitemap-Tier2-*`.
 */

/**
 * How long one instance reuses a trust verdict and its ≤20 group rows.
 *
 * Short, unlike the six-hour item/summary TTLs around it, because the read is one
 * heap page and the cost of being wrong is real: a verdict cached across a
 * refresh advertises yesterday's page count against today's rows. Five minutes
 * bounds that window to a few minutes a day and costs ~12 single-page reads per
 * instance per hour.
 */
const VERDICT_TTL_MS = 5 * 60 * 1000;

/**
 * Per-reason floor on Sentry emission, so a crawl burst across thirteen pages
 * cannot turn one degradation into thirteen events. The single-flight below
 * already collapses concurrent callers; this bounds the sequential case too.
 */
const REPORT_FLOOR_MS = 6 * 60 * 60 * 1000;

let cachedVerdict: { builtAt: number; verdict: Tier2Verdict } | null = null;
let verdictInFlight: Promise<Tier2Verdict> | null = null;
let cachedFingerprint: string | null = null;
const lastReportedAt = new Map<string, number>();

/**
 * Warnings from the last config cross-check, which runs post-flush rather than in
 * the request (see `auditTier2ConfigDrift`). Surfaced on the response so a
 * `curl -I` can see it — one crawl behind, which is honest and self-heals.
 */
let lastAuditWarnings: string[] = [];

function fingerprint(): string {
  cachedFingerprint ??= tier2PredicateFingerprint(dbzRead);
  return cachedFingerprint;
}

/** Fires at most once per reason per `REPORT_FLOOR_MS`, per instance. */
function report(slug: string, level: 'error' | 'warning', detail: string): void {
  const now = Date.now();
  const previous = lastReportedAt.get(slug);
  if (previous !== undefined && now - previous < REPORT_FLOOR_MS) return;
  lastReportedAt.set(slug, now);

  const message = `[sitemap] tier-2 table: ${detail}`;
  if (level === 'error') {
    console.error(message);
  } else {
    console.warn(message);
  }
  Sentry.captureMessage(message, level);
}

async function fetchTier2GroupRows(): Promise<Tier2GroupRow[]> {
  // `ORDER BY board_type, layout_id` matches `chooseWinningConfigPerLayout`'s own
  // sort. That is not cosmetic: this order is what decides which page a climb
  // falls on, so the summary and the page build have to agree on it.
  return dbzRead
    .select({
      boardType: sitemapTier2Groups.boardType,
      layoutId: sitemapTier2Groups.layoutId,
      sizeId: sitemapTier2Groups.sizeId,
      setIds: sitemapTier2Groups.setIds,
      itemCount: sitemapTier2Groups.itemCount,
      lastModified: sitemapTier2Groups.lastModified,
      predicateFingerprint: sitemapTier2Groups.predicateFingerprint,
      refreshedAt: sitemapTier2Groups.refreshedAt,
    })
    .from(sitemapTier2Groups)
    .orderBy(asc(sitemapTier2Groups.boardType), asc(sitemapTier2Groups.layoutId));
}

async function computeVerdict(): Promise<Tier2Verdict> {
  let storedGroups: Tier2GroupRow[];
  try {
    storedGroups = await fetchTier2GroupRows();
  } catch (err) {
    // Most likely the migration has not applied yet. Degrading to the live scan
    // is exactly main's behaviour, so this is never worse than before the table
    // existed — but it must not be silent.
    report(
      'read-failed',
      'error',
      `could not read sitemap_tier2_groups, falling back to the live scan: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { source: 'live', reason: 'empty', groups: [], ageHours: null, warnings: [] };
  }

  // `resolvedGroups: null` on purpose. The cross-check needs
  // `getAllBoardConfigsOrThrow()`, a GraphQL fetch measured at ~10 s cold (#4519),
  // and the point of this table is that the read path stops depending on it. The
  // drift detector runs post-flush instead — `auditTier2ConfigDrift`.
  const verdict = verifyTier2Table({
    storedGroups,
    resolvedGroups: null,
    runtimeFingerprint: fingerprint(),
    isResolvable: isResolvableGroup,
    now: new Date(),
  });

  if (verdict.source === 'live') {
    report(
      verdict.reason,
      'error',
      verdict.reason === 'empty'
        ? 'no rows in sitemap_tier2_groups — serving the climbs shard from the live scan. Dispatch the "Refresh Sitemap Tier 2" workflow.'
        : 'the stored rows were selected by a different predicate than the code now runs — serving the climbs shard from the live scan until a refresh runs.',
    );
    return verdict;
  }

  if (verdict.warnings.includes('severely-stale')) {
    report(
      'severely-stale',
      'error',
      `the materialised climb sitemap is ${verdict.ageHours}h old — the refresh cron has not run in two weeks. Still serving it, because a stale complete shard beats an absent one.`,
    );
  } else if (verdict.warnings.includes('stale')) {
    report(
      'stale',
      'warning',
      `the materialised climb sitemap is ${verdict.ageHours}h old — the refresh cron looks stuck. Still serving it.`,
    );
  }
  if (verdict.warnings.includes('unresolvable-group')) {
    report(
      'unresolvable-group',
      'warning',
      'a stored group has no readable URL and was dropped from the served set, same as the live path drops it.',
    );
  }

  return verdict;
}

/**
 * The trust verdict plus the group rows to serve, behind a short TTL and a
 * single-flight promise.
 *
 * The single flight is what makes the Sentry channel usable: a cold crawl is
 * `/sitemap.xml` plus every `/sitemaps/climbs/N.xml` arriving together, and
 * without it one degradation would be one event per concurrent caller.
 */
export async function fetchTier2TableVerdict(): Promise<Tier2Verdict> {
  if (cachedVerdict && Date.now() - cachedVerdict.builtAt < VERDICT_TTL_MS) {
    return cachedVerdict.verdict;
  }
  if (verdictInFlight) {
    return verdictInFlight;
  }

  const build = computeVerdict().then((verdict) => {
    cachedVerdict = { builtAt: Date.now(), verdict };
    return verdict;
  });
  verdictInFlight = build;

  try {
    return await build;
  } finally {
    verdictInFlight = null;
  }
}

/**
 * The shard's count and freshness from the table, or null when the caller must
 * fall back.
 *
 * One heap page, ~2 ms at every temperature, against the ~3,032 ms warm live scan
 * this replaces. The count sums only the groups the read path can actually
 * address, so it matches the set `buildTier2TablePage` emits — the page count and
 * the emitted URLs come from one epoch, which is what `sitemap_shard_refreshes`
 * on its own could not guarantee.
 */
export async function fetchTier2TableSummary(): Promise<Tier2Summary | null> {
  const verdict = await fetchTier2TableVerdict();
  if (verdict.source !== 'table') return null;

  let itemCount = 0;
  let lastModified: Date | null = null;
  for (const group of verdict.groups) {
    itemCount += group.itemCount;
    if (group.lastModified && (!lastModified || group.lastModified > lastModified)) {
      lastModified = group.lastModified;
    }
  }

  return { itemCount, lastModified };
}

/**
 * Page `page` built from the table, or null when the caller must fall back.
 *
 * `planTier2Pages` turns the page number into the one or two
 * `(group, offset, limit)` triples it spans; each is a PK-prefix index range
 * scan of at most `urlsPerPage` rows, run sequentially so a crawl burst cannot
 * fan concurrent scans at a ten-connection pool.
 *
 * URLs are built by `climbRowsToItems` from the group's STORED config, not from
 * whatever the live ranking resolves today — the rows were selected under that
 * config, and `tryConstructSlugViewUrl` is the first branch of
 * `buildCanonicalClimbViewUrl`, so a resolvable config yields a URL byte-identical
 * to that page's own canonical.
 */
export async function buildTier2TablePage(
  page: number,
  urlsPerPage: number,
): Promise<{ items: SitemapItem[]; totalItems: number } | null> {
  const verdict = await fetchTier2TableVerdict();
  if (verdict.source !== 'table') return null;

  const totalItems = verdict.groups.reduce((total, group) => total + group.itemCount, 0);
  const items: SitemapItem[] = [];
  let dropped = 0;

  for (const slice of planTier2Pages(verdict.groups, page, urlsPerPage)) {
    const rows = await dbzRead
      .select({
        climbUuid: sitemapTier2Climbs.climbUuid,
        angle: sitemapTier2Climbs.angle,
        climbName: sitemapTier2Climbs.climbName,
        lastModified: sitemapTier2Climbs.lastModified,
      })
      .from(sitemapTier2Climbs)
      .where(
        and(
          eq(sitemapTier2Climbs.boardType, slice.group.boardType),
          eq(sitemapTier2Climbs.layoutId, slice.group.layoutId),
        ),
      )
      .orderBy(asc(sitemapTier2Climbs.climbUuid))
      .offset(slice.offset)
      .limit(slice.limit);

    const built = climbRowsToItems(
      rows.map((row) => ({
        uuid: row.climbUuid,
        name: row.climbName,
        angle: row.angle,
        updatedAt: row.lastModified,
      })),
      slice.group,
    );
    for (const item of built.items) {
      items.push(item);
    }
    dropped += built.dropped;
  }

  if (dropped > 0) {
    // Should be zero: `verifyTier2Table` already dropped whole groups it cannot
    // address. A per-row drop means a climb vanished rather than being published
    // under a URL we can prove matches its own canonical.
    report('rows-dropped', 'warning', `${dropped} stored rows on page ${page} had no resolvable canonical URL.`);
  }

  return { items, totalItems };
}

/**
 * Headers that say, on every sitemap response, which path served it.
 *
 * Mirrors the `X-Sitemap-Degraded` precedent: legible from a `curl -I`, which is
 * how the #4583 hole was finally caught, and asserted by the post-deploy smoke.
 * Cheap — the verdict is already memoised by the time a handler asks.
 */
export async function tier2SourceHeaders(): Promise<Record<string, string>> {
  let verdict: Tier2Verdict;
  try {
    verdict = await fetchTier2TableVerdict();
  } catch {
    return { 'X-Sitemap-Tier2-Source': 'live', 'X-Sitemap-Tier2-Reason': 'verdict-failed' };
  }

  const headers: Record<string, string> = { 'X-Sitemap-Tier2-Source': verdict.source };
  if (verdict.source === 'live') {
    headers['X-Sitemap-Tier2-Reason'] = verdict.reason;
  }
  if (verdict.ageHours !== null) {
    headers['X-Sitemap-Tier2-Age-Hours'] = String(verdict.ageHours);
  }
  const drift = [...verdict.warnings, ...lastAuditWarnings];
  if (drift.length > 0) {
    headers['X-Sitemap-Tier2-Drift'] = [...new Set(drift)].join(',');
  }
  return headers;
}

/**
 * The config cross-check: does the table still describe the groups web resolves?
 *
 * Runs from `after()` on `/sitemap.xml`, never in a request, because it needs
 * `getAllBoardConfigsOrThrow()` — the ~10 s cold GraphQL fetch that caused #4519.
 * Keeping it off the critical path is the point of the table.
 *
 * It is a DETECTOR, never a gate. Neither a missing group nor a changed winning
 * config makes the table the wrong answer:
 *
 *  - a group web resolves and the table lacks is absent until the next refresh
 *    (this is the shape #4578 creates the moment it merges), and the rest of the
 *    shard keeps serving;
 *  - a stored config that differs from today's winner still wins, because the
 *    rows were selected under it and its URLs are self-canonical either way.
 *
 * A failure here — GraphQL down — is not a fallback either. It just means the
 * detector could not run.
 */
export async function auditTier2ConfigDrift(): Promise<void> {
  try {
    const verdict = await fetchTier2TableVerdict();
    if (verdict.source !== 'table') return;

    const audited = verifyTier2Table({
      storedGroups: verdict.groups,
      resolvedGroups: resolveClimbSitemapGroups(await getAllBoardConfigsOrThrow()),
      runtimeFingerprint: fingerprint(),
      isResolvable: isResolvableGroup,
      now: new Date(),
    });

    lastAuditWarnings = audited.warnings.filter((warning) => warning === 'config-drift' || warning === 'missing-group');

    if (audited.warnings.includes('missing-group')) {
      report(
        'missing-group',
        'warning',
        'web resolves a board configuration the materialised sitemap has no rows for — those URLs are absent until the next refresh. Dispatch "Refresh Sitemap Tier 2".',
      );
    }
    if (audited.warnings.includes('config-drift')) {
      report(
        'config-drift',
        'warning',
        'the winning board configuration changed since the last refresh — serving the stored one, which stays self-canonical. Converges on the next refresh.',
      );
    }
  } catch (err) {
    report(
      'audit-failed',
      'warning',
      `the tier-2 config cross-check could not run: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Test seam: drops the verdict cache, the report floor and the last audit. */
export function resetTier2TableStateForTests(): void {
  cachedVerdict = null;
  verdictInFlight = null;
  cachedFingerprint = null;
  lastReportedAt.clear();
  lastAuditWarnings = [];
}
