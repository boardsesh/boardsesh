import type { SprayWallHealthMetrics } from '@boardsesh/db/jobs';

/**
 * The `Spray Wall Health Weekly` reporting contract (issue #6062).
 *
 * One event per week, emitted by the `spray-wall-health` batch family from
 * aggregates read straight off the app tables — the stock answer to "how are
 * the walls doing?" that no client-side funnel carries (every spray event
 * starts with somebody acting on a wall; nothing says how the fleet's walls
 * are living afterwards). The metric definitions live with the numbers in
 * `@boardsesh/db/jobs` (`computeSprayWallHealth`); this file pins how they
 * travel: one fixed non-person actor, and the no-cohort rule.
 *
 * **No cohort, not zero.** When the fleet has no live spray walls, the event
 * carries only `wallsLive: 0` — every activity metric would be an empty-set
 * artifact, and a dashboard reading them as zeros would show "walls exist but
 * nobody climbs" from a world with no walls at all. The absence IS the
 * measurement, and `docs/growth-metrics.md` documents it as such.
 */
export const SPRAY_WALL_HEALTH_EVENT = 'Spray Wall Health Weekly' as const;

/**
 * The actor for a personless weekly aggregate. Never a real id: no climber
 * should resolve against this event, and PostHog counts it like any other
 * series on the growth dashboard's fixed `$lib = posthog-node` population.
 */
export function sprayWallHealthDistinctId(weekStart: string): string {
  return `spray-wall-health:${weekStart}`;
}

export function buildSprayWallHealthProperties(
  weekStart: string,
  metrics: SprayWallHealthMetrics,
): Record<string, string | number> {
  const properties: Record<string, string | number> = { weekStart };
  if (metrics.wallsLive === 0) {
    // The no-cohort bag: wallsLive says why the rest is absent.
    properties.wallsLive = 0;
    return properties;
  }
  for (const [metric, value] of Object.entries(metrics)) {
    properties[metric] = value;
  }
  return properties;
}
