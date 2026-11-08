/// <reference types="node" />
/**
 * vp exec node --import tsx scripts/posthog/backfill-historical-active-users.ts [--apply]
 * Apply queues and flushes aggregates. Verify their arrival in PostHog separately:
 * the shared analytics flush helper logs delivery errors without throwing.
 */
import process from 'node:process';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

type HistoricalSnapshotBatch = readonly Record<string, string | number>[];

type HistoricalActiveUsersModule = {
  computeHistoricalActiveUsersSnapshots: () => Promise<HistoricalSnapshotBatch>;
  publishHistoricalActiveUsersSnapshots: (snapshots: HistoricalSnapshotBatch) => Promise<void>;
};

async function main(): Promise<void> {
  // Runtime value paths keep the backend's web/Next global types out of the
  // root scripts typecheck. The backend typecheck owns the implementation.
  const repositoryRoot = resolve(__dirname, '../..');
  const { closePool, closeReadPool } = (await import(resolve(repositoryRoot, 'packages/db/src/client/index.ts'))) as {
    closePool: () => Promise<void>;
    closeReadPool: () => Promise<void>;
  };
  const { computeHistoricalActiveUsersSnapshots, publishHistoricalActiveUsersSnapshots } = (await import(
    resolve(repositoryRoot, 'packages/backend/src/services/historical-active-users.ts')
  )) as HistoricalActiveUsersModule;
  const { shutdownPosthog } = (await import(
    resolve(repositoryRoot, 'packages/backend/src/services/analytics/posthog.ts')
  )) as {
    shutdownPosthog: () => Promise<void>;
  };

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
