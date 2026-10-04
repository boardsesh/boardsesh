import { logger } from '../../../utils/logger';

/** A read slower than this is logged. Warm, these resolvers answer in tens of ms. */
const SLOW_READ_MS = 1000;

/**
 * Logs a resolver's database time when it was slow, with enough to say which
 * request it was. Quiet otherwise, so a hot resolver adds no log volume.
 *
 * Here because GraphQL traces are sampled at 1%: a climber's "the logbook took
 * ten seconds" is almost never in a trace, and without this there is no
 * production number to hold it against (#5986).
 */
export function logSlowRead(resolver: string, startedAt: number, fields: Record<string, unknown>): void {
  const durationMs = Math.round(performance.now() - startedAt);
  if (durationMs < SLOW_READ_MS) return;
  logger.warn(`[${resolver}] slow read`, { durationMs, ...fields });
}
