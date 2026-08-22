/**
 * Floor on a plausible tier-2 build.
 *
 * Production measured 53,262 items on 2026-08-21 (Aurora boards only), and
 * ~126,500 once MoonBoard's synthetic groups land (#4578). 40,000 sits under both
 * with room for a real dip, and far above any predicate regression — those
 * collapse to hundreds or to zero, not to two thirds.
 */
export const MIN_EXPECTED_TIER2_ITEMS = 40_000;

export type Tier2RefreshPlan = { action: 'commit' } | { action: 'abort'; reason: 'below-floor' | 'catastrophic-drop' };

/**
 * Whether a freshly built tier-2 row set may replace the stored one.
 *
 * The whole reason this exists: the write is one transaction that deletes both
 * tables and re-inserts, so a predicate regression matching zero rows would swap
 * ~126,500 URLs for nothing, atomically, on a green cron run — the same
 * silent-degrade class as the bug this table fixes, only faster. An abort writes
 * nothing and leaves the last good table serving.
 *
 * A first run has no baseline and must not be blocked by its absence, so only the
 * absolute floor applies there. The proportional guard needs a previous total to
 * be a guard at all.
 *
 * Deliberately no `force` escape hatch. Unlike the shrink guard in
 * `climb-store.ts`, which fronts a request path that would otherwise wedge, this
 * runs in a cron that already has `workflow_dispatch`: if a shrink is genuinely
 * real, lowering `MIN_EXPECTED_TIER2_ITEMS` in a reviewed commit is the honest way
 * to say so.
 */
export function planTier2Refresh(input: { builtTotal: number; previousTotal: number | null }): Tier2RefreshPlan {
  if (input.builtTotal < MIN_EXPECTED_TIER2_ITEMS) {
    return { action: 'abort', reason: 'below-floor' };
  }
  if (input.previousTotal !== null && input.builtTotal * 2 < input.previousTotal) {
    return { action: 'abort', reason: 'catastrophic-drop' };
  }
  return { action: 'commit' };
}
