import type { IncomingMessage, ServerResponse } from 'http';
import { applyCorsHeaders } from './cors';

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * Handle shared-sync cron endpoint
 *
 * The shared sync is responsible for syncing global board data (climbs, stats,
 * beta links) from Aurora's API. This is a complex process that was previously
 * handled in the Next.js API route at /api/internal/shared-sync/[board_name].
 *
 * For now, we expose this as an HTTP endpoint that the external cron service
 * can call. The actual sync logic lives in @boardsesh/aurora-sync package's
 * sharedSync function, but the full recursive sync + notification creation
 * needs to be ported from the web package.
 *
 * TODO: Port the full shared sync logic from packages/web/app/lib/data-sync/aurora/shared-sync.ts
 * This includes:
 * - Recursive sync until complete
 * - Upsert of climbs, climb_stats, beta_links, attempts
 * - Climb holds generation from frames
 * - Setter sync notifications
 */
export async function handleSharedSyncCron(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Apply CORS headers
  if (!applyCorsHeaders(req, res)) return;

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Auth check
  const authHeader = req.headers['authorization'];
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  // Extract board name from URL
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const boardName = url.searchParams.get('board');

  if (!boardName || (boardName !== 'kilter' && boardName !== 'tension')) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid board name. Must be "kilter" or "tension".' }));
    return;
  }

  // Check for sync token
  const AURORA_TOKENS: Record<string, string | undefined> = {
    kilter: process.env.KILTER_SYNC_TOKEN,
    tension: process.env.TENSION_SYNC_TOKEN,
  };

  const token = AURORA_TOKENS[boardName];
  if (!token) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `No sync token configured for ${boardName}` }));
    return;
  }

  // For now, return a stub response indicating the endpoint is ready
  // The full sync logic will be ported in a later phase
  console.log(`[SharedSync] Shared sync cron hit for ${boardName} - endpoint registered`);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    success: true,
    message: `Shared sync endpoint registered for ${boardName}. Full sync logic pending migration.`,
    board: boardName,
  }));
}
