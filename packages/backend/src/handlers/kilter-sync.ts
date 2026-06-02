import type { IncomingMessage, ServerResponse } from 'http';
import * as Sentry from '@sentry/node';
import { SyncRunner as KilterSyncRunner } from '@boardsesh/kilter-sync/runner';
import { applyCorsHeaders } from './cors';
import { logger } from '../utils/logger';

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * /kilter-sync-cron — the sibling of /sync-cron for the kilter-sync daemon.
 * Same shape (Bearer CRON_SECRET, syncs one user per call) so the external
 * cron service can hit both with identical config; same per-cycle-one-user
 * policy so we don't fan out PowerSync connections in lockstep across many
 * users.
 *
 * The /sync-cron (aurora-sync) and /kilter-sync-cron (this handler) are
 * deliberately separate endpoints rather than dispatching by boardType on a
 * single endpoint because:
 *   - their transports differ (REST /sync vs PowerSync stream),
 *   - their failure modes have different retry budgets,
 *   - separate endpoints let cron-job.org schedule them at different cadences.
 */
export async function handleKilterSyncCron(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Fail-closed when CRON_SECRET is unset. The legacy aurora-sync pattern
  // bypassed the auth check in that case, which means a missing env var
  // (typo'd in Vercel, dropped during a config rewrite, missing in a new
  // env) silently exposes the endpoint to anyone who knows the path. We
  // refuse to serve the route at all rather than serve it without auth.
  if (!CRON_SECRET) {
    logger.error('[KilterSync] CRON_SECRET is not set — refusing to handle /kilter-sync-cron');
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'CRON_SECRET is not configured on the server' }));
    return;
  }
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  logger.info('[KilterSync] Starting kilter-sync cron job (1 user)...');

  const runner = new KilterSyncRunner({
    onLog: (msg: string) => logger.info(`[KilterSync] ${msg}`),
    onError: (error: Error, context: { userId?: string; board?: string }) => {
      logger.error(`[KilterSync] Error for ${context.userId}/${context.board}:`, error.message);
      Sentry.captureException(error, {
        tags: { source: 'kilter-sync', board: context.board },
        // user.id is the PII-aware field — Sentry knows to scrub it
        // when "Scrub IP Addresses" / data-scrubbing rules are on.
        // `extra` is unscrubbed, which would leak our NextAuth user ID
        // into the error sidebar.
        user: context.userId ? { id: context.userId } : undefined,
      });
    },
  });

  try {
    const result = await runner.syncNextUser();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        success: true,
        results: {
          total: result.total,
          successful: result.successful,
          failed: result.failed,
        },
        errors: result.errors,
        timestamp: new Date().toISOString(),
      }),
    );

    logger.info(`[KilterSync] Completed: ${result.successful}/${result.total} user synced`);
  } catch (error) {
    logger.error('[KilterSync] Cron job failed:', error);
    Sentry.captureException(error, { tags: { source: 'kilter-sync-cron' } });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
    );
  } finally {
    await runner.stop();
  }
}
