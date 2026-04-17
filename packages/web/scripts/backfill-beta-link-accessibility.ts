#!/usr/bin/env node

import { loadEnvConfig } from '@next/env';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageDir = join(__dirname, '..');

loadEnvConfig(packageDir);

const batchSize = Number(process.env.BETA_LINK_BATCH_SIZE ?? 250);
const concurrency = Number(process.env.BETA_LINK_CONCURRENCY ?? 6);
const deadlineMs = Number(process.env.BETA_LINK_DEADLINE_MS ?? 45_000);
const sleepMs = Number(process.env.BETA_LINK_SLEEP_MS ?? 1_000);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { runBetaLinkRevalidationBatch } = await import('../app/lib/beta-link-revalidation');

  console.log('=== Backfill Beta Link Accessibility ===');
  console.log(`batchSize=${batchSize} concurrency=${concurrency} deadlineMs=${deadlineMs}`);

  let iteration = 0;
  let totalProcessed = 0;
  let totalAccessible = 0;
  let totalInaccessible = 0;

  while (true) {
    iteration += 1;
    const result = await runBetaLinkRevalidationBatch({
      batchSize,
      concurrency,
      deadlineMs,
    });

    totalProcessed += result.processed;
    totalAccessible += result.madeAccessible;
    totalInaccessible += result.madeInaccessible;

    console.log(
      `[${iteration}] processed=${result.processed} accessible=${result.madeAccessible} inaccessible=${result.madeInaccessible} remaining=${result.remainingEligible}`,
    );

    if (result.remainingEligible === 0 || result.processed === 0) {
      break;
    }

    await sleep(sleepMs);
  }

  console.log(
    `Done. totalProcessed=${totalProcessed} totalAccessible=${totalAccessible} totalInaccessible=${totalInaccessible}`,
  );
}

main().catch((error) => {
  console.error('Backfill failed:', error);
  process.exit(1);
});
