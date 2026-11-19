import { sql } from 'drizzle-orm';
import { executeFirstRow } from '@boardsesh/db/client';
import { db, type Database } from '../../db/client';
import { captureBackendEvent } from '../analytics/posthog';
import { logger } from '../../utils/logger';
let lastHorizonAlertAt = 0;

/** One catalog read and one primary-key probe; never scans the change history. */
export async function reportPartnerFeedHealth(database: Database = db): Promise<void> {
  const result = await executeFirstRow<{
    oldest_write_seconds: string | number;
    horizon: string;
    latest_change_txid: string | null;
  }>(
    database,
    sql`
    SELECT coalesce((SELECT max(extract(epoch FROM clock_timestamp() - xact_start))
                       FROM pg_stat_activity
                      WHERE backend_xid IS NOT NULL
                        AND pid <> pg_backend_pid()), 0) AS oldest_write_seconds,
           pg_snapshot_xmin(pg_current_snapshot())::text AS horizon,
           (SELECT changes.txid::text FROM (
             SELECT txid, seq FROM public.logbook_changes UNION ALL
             SELECT txid, seq FROM public.logbook_session_changes
           ) changes ORDER BY changes.txid DESC, changes.seq DESC LIMIT 1) AS latest_change_txid
  `,
  );
  if (!result) return;
  const oldestWriteSeconds = Math.max(0, Number(result.oldest_write_seconds));
  // Transaction distance is a pressure indicator, not elapsed time or a row count.
  const distance = result.latest_change_txid ? BigInt(result.latest_change_txid) - BigInt(result.horizon) : 0n;
  const summary = {
    oldest_write_seconds: oldestWriteSeconds,
    change_horizon_xid_distance: Number(distance > 0n ? distance : 0n),
  };
  captureBackendEvent('Public API Feed Health', { systemDistinctId: 'system:public-api-feed', properties: summary });
  if (oldestWriteSeconds > 300 && Date.now() - lastHorizonAlertAt >= 15 * 60_000) {
    lastHorizonAlertAt = Date.now();
    logger.error('[PartnerFeed] Write transaction holds the feed horizon', {
      ...summary,
      error: new Error('Partner logbook write transaction exceeded five minutes'),
    });
  }
}
