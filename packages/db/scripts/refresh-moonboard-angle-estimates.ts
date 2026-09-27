/**
 * MoonBoard same-board angle grade estimate refresh. The job body is
 * `src/jobs/refresh-moonboard-angle-estimates.ts`; the batch worker's
 * `refresh-moonboard-angle-estimates` family runs the same body
 * (docs/background-workers.md).
 *
 * Run locally: `vp run db:refresh-moonboard-angle-estimates -- --dry-run`
 * Flags: --validate-only (fit the coefficients and print the per-band report,
 * touch nothing), --dry-run (full plan including row shapes, write nothing),
 * --publish (the only flag that writes; off by default).
 */
import {
  MoonboardFitUnusableError,
  parseMoonboardAngleEstimateFlags,
  runMoonboardAngleEstimates,
} from '../src/jobs/index.js';
import { createScriptDb } from './db-connection.js';
import { cliJobLogger } from './job-cli.js';

async function main(): Promise<void> {
  const flags = parseMoonboardAngleEstimateFlags(process.argv);
  const { db, close } = createScriptDb();
  try {
    await runMoonboardAngleEstimates({
      db,
      signal: new AbortController().signal,
      log: cliJobLogger(),
      ...flags,
    });
  } finally {
    await close();
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error: unknown) => {
    if (error instanceof MoonboardFitUnusableError) {
      console.error('[moon-angle] pooled fit is unusable — nothing written.', error.message);
    } else {
      console.error('[moon-angle] failed:', error);
    }
    process.exit(1);
  },
);
