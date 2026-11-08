/// <reference types="node" />
/**
 * vp exec node --import tsx scripts/posthog/backfill-historical-active-users.ts [--apply]
 * Apply queues and flushes aggregates. Verify their arrival in PostHog separately:
 * the shared analytics flush helper logs delivery errors without throwing.
 */
import process from 'node:process';
import { parseArgs } from 'node:util';
import { closePool, closeReadPool } from '../../packages/db/src/client';
import {
  computeHistoricalActiveUsersSnapshots,
  publishHistoricalActiveUsersSnapshots,
} from '../../packages/backend/src/services/historical-active-users';
import { shutdownPosthog } from '../../packages/backend/src/services/analytics/posthog';

async function main(): Promise<void> {
  try {
    const { values } = parseArgs({ options: { apply: { type: 'boolean', default: false } }, allowPositionals: false });
    const snapshots = await computeHistoricalActiveUsersSnapshots();
    process.stdout.write(`${JSON.stringify({ mode: values.apply ? 'apply' : 'dry-run', snapshots }, null, 2)}\n`);
    if (values.apply) await publishHistoricalActiveUsersSnapshots(snapshots);
  } finally {
    await shutdownPosthog();
    await closeReadPool();
    await closePool();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
