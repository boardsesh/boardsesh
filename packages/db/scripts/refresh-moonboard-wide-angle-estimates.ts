/**
 * MoonBoard wide-angle grade estimate refresh. The job body is
 * `src/jobs/refresh-moonboard-wide-angle-estimates.ts`; the batch worker's
 * `refresh-moonboard-wide-angle-estimates` family runs the same body
 * (docs/background-workers.md).
 *
 * Run locally: `vp run db:refresh-moonboard-wide-angle-estimates -- --dry-run`
 * Flags: --dry-run (full plan including row shapes, write nothing),
 * --publish (the only flag that writes; off by default).
 */
import { MoonboardFitUnusableError, runMoonboardWideAngleEstimates } from '../src/jobs/index.js';
import { createScriptDb } from './db-connection.js';
import { cliJobLogger } from './job-cli.js';

async function main(argv: string[]): Promise<void> {
  const { db, close } = createScriptDb();
  try {
    await runMoonboardWideAngleEstimates({
      db,
      signal: new AbortController().signal,
      log: cliJobLogger(),
      dryRun: argv.includes('--dry-run'),
      publish: argv.includes('--publish'),
    });
  } finally {
    await close();
  }
}

main(process.argv.slice(2)).then(
  () => process.exit(process.exitCode ?? 0),
  (error: unknown) => {
    if (error instanceof MoonboardFitUnusableError) {
      console.error('[moon-wide] no angle-surface coverage from any shape board — nothing written.', error.message);
    } else {
      console.error('[moon-wide] failed:', error);
    }
    process.exit(1);
  },
);
