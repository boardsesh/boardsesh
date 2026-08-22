import { climbGroupKey, type ClimbConfigGroup } from './tier2-groups';

/** One row of `sitemap_tier2_groups`, as the read path sees it. */
export type Tier2GroupRow = {
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: number[];
  itemCount: number;
  lastModified: Date | null;
  predicateFingerprint: string;
  refreshedAt: Date;
};

/**
 * Why the read path is on the live scan instead of the table. `'ok'` means it is
 * on the table. These strings are the `X-Sitemap-Tier2-Reason` header value and
 * the Sentry message suffix, so keep them short and stable.
 */
export type Tier2FallbackReason = 'ok' | 'empty' | 'predicate-drift';

/**
 * Something is off but the table is still the better answer. Slugs, same
 * contract as the reason above.
 */
export type Tier2Warning = 'stale' | 'severely-stale' | 'config-drift' | 'missing-group' | 'unresolvable-group';

export type Tier2Verdict = {
  source: 'table' | 'live';
  reason: Tier2FallbackReason;
  /** The stored groups the read path will actually serve; empty on the live path. */
  groups: Tier2GroupRow[];
  /** Age of the oldest stored group in whole hours, or null when there are none. */
  ageHours: number | null;
  warnings: Tier2Warning[];
};

/**
 * Older than this and the read path shouts. Well past the 24 h refresh cadence:
 * this is "the cron is gone", not "this is slightly behind".
 */
export const TIER_2_STALE_AFTER_HOURS = 36;
/** Older than this and it escalates from a warning to an error-level event. */
export const TIER_2_SEVERELY_STALE_AFTER_HOURS = 14 * 24;

function ageHoursOf(refreshedAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - refreshedAt.getTime()) / 3_600_000));
}

function sameSetIds(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Decide whether `/sitemaps/climbs/N.xml` and `/sitemap.xml` serve from
 * `sitemap_tier2_*` or fall back to the live `DISTINCT ON` scan, and say loudly
 * why.
 *
 * **Staleness never causes a fallback, and that is the least obvious decision in
 * this design.** A three-day-old but complete table beats a live scan that blows
 * `SHARD_DEADLINE_MS` and gets the shard dropped from the index entirely.
 * Falling back on staleness would trade "slightly stale" for "absent", which is
 * the mistake #4583 is about, inverted. Only two things make the stored rows the
 * *wrong set* rather than an old one, and only those fall back:
 *
 *  - **`empty`** — nothing has been refreshed. There is nothing to serve.
 *  - **`predicate-drift`** — the rows were selected by different SQL than the
 *    code now runs. A tightened angle filter, say, would have us submitting URLs
 *    that 404 today, and submitting 404s is worse than a degraded index.
 *
 * Everything else warns and serves:
 *
 *  - a stored group web can no longer address is dropped from the served set,
 *    exactly as the live path drops it;
 *  - a group web resolves that the table lacks (the shape #4578 creates the
 *    moment it merges) is absent until the next refresh — the rest still serves;
 *  - a stored config that differs from today's resolved winner still wins,
 *    because the ROWS were selected under the stored config, and
 *    `tryConstructSlugViewUrl` is the first branch of `buildCanonicalClimbViewUrl`
 *    so any resolvable config yields a URL byte-identical to that page's own
 *    canonical. A ranking flip is cosmetic; a degraded index is not. It converges
 *    on the next refresh.
 *
 * `resolvedGroups` is `null` when the cross-check itself could not run (the
 * GraphQL config fetch is down). The cross-check is a detector, never a gate, so
 * that is not a fallback either — the table still serves.
 */
export function verifyTier2Table(input: {
  storedGroups: readonly Tier2GroupRow[];
  /** What web resolves today, or null when that could not be determined. */
  resolvedGroups: readonly ClimbConfigGroup[] | null;
  runtimeFingerprint: string;
  isResolvable: (group: ClimbConfigGroup) => boolean;
  now: Date;
}): Tier2Verdict {
  const { storedGroups, resolvedGroups, runtimeFingerprint, isResolvable, now } = input;

  if (storedGroups.length === 0) {
    return { source: 'live', reason: 'empty', groups: [], ageHours: null, warnings: [] };
  }

  const ageHours = Math.max(...storedGroups.map((group) => ageHoursOf(group.refreshedAt, now)));

  if (storedGroups.some((group) => group.predicateFingerprint !== runtimeFingerprint)) {
    return { source: 'live', reason: 'predicate-drift', groups: [], ageHours, warnings: [] };
  }

  const warnings: Tier2Warning[] = [];
  if (ageHours >= TIER_2_SEVERELY_STALE_AFTER_HOURS) {
    warnings.push('severely-stale');
  } else if (ageHours >= TIER_2_STALE_AFTER_HOURS) {
    warnings.push('stale');
  }

  const groups: Tier2GroupRow[] = [];
  for (const stored of storedGroups) {
    if (!isResolvable(stored)) {
      if (!warnings.includes('unresolvable-group')) warnings.push('unresolvable-group');
      continue;
    }
    groups.push(stored);
  }

  if (resolvedGroups !== null) {
    const storedByKey = new Map(storedGroups.map((group) => [climbGroupKey(group.boardType, group.layoutId), group]));
    for (const resolved of resolvedGroups) {
      const stored = storedByKey.get(climbGroupKey(resolved.boardType, resolved.layoutId));
      if (!stored) {
        if (!warnings.includes('missing-group')) warnings.push('missing-group');
        continue;
      }
      if (stored.sizeId !== resolved.sizeId || !sameSetIds(stored.setIds, resolved.setIds)) {
        if (!warnings.includes('config-drift')) warnings.push('config-drift');
      }
    }
  }

  return { source: 'table', reason: 'ok', groups, ageHours, warnings };
}

/** One bounded range scan the page build has to run. */
export type Tier2PageSlice = {
  group: Tier2GroupRow;
  offset: number;
  limit: number;
};

/**
 * The `(group, offset, limit)` triples page `page` spans — usually one group,
 * occasionally two where a page straddles a group boundary.
 *
 * This is the only genuinely new arithmetic in #4583, and an off-by-one here
 * drops or duplicates exactly one URL per boundary — 12 URLs out of 126,500 with
 * thirteen pages, invisible to any count assertion. Its test asserts the literal
 * triple list, not a row count, for that reason.
 *
 * Groups must arrive in the same order the summary summed them, because that
 * order is what defines which page a climb falls on.
 */
export function planTier2Pages(groups: readonly Tier2GroupRow[], page: number, urlsPerPage: number): Tier2PageSlice[] {
  const pageStart = (page - 1) * urlsPerPage;
  const pageEnd = pageStart + urlsPerPage;

  const slices: Tier2PageSlice[] = [];
  let cursor = 0;

  for (const group of groups) {
    const groupStart = cursor;
    const groupEnd = groupStart + group.itemCount;
    cursor = groupEnd;

    if (groupEnd <= pageStart) continue;
    if (groupStart >= pageEnd) break;

    const from = Math.max(pageStart, groupStart);
    const to = Math.min(pageEnd, groupEnd);
    if (to <= from) continue;

    slices.push({ group, offset: from - groupStart, limit: to - from });
  }

  return slices;
}
