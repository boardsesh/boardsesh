/**
 * Nightly Boardsesh grade refresh. The job body, and the model notes behind
 * every threshold, are in `src/jobs/refresh-climb-grades.ts` and
 * docs/boardsesh-grade.md; the batch worker runs the same body.
 *
 * Run locally: `vp run db:refresh-climb-grades --`
 * Flags: --refit-coefficients (force a refit), --dry-run (gates + stats only),
 * --validate-only (read-only gates report, works without the grade tables),
 * --allow-empty-backtest (dev DBs without stats history: skip the backtest
 * instead of blocking — never use in prod), --publish-cross-angle-estimates
 * (rollout switch; enable only after compatible mobile clients are required),
 * --content-prior-file=<path> (score CANDIDATE content priors from an offline
 * JSONL file instead of board_climb_embeddings — pair with --validate-only or
 * --dry-run to keep it read-only; adds the report-only content_prior_backtest
 * gate per board present in the file).
 * A blocking gate failure exits 1 with nothing written.
 */
import { GradeGatesFailedError, runRefreshClimbGrades } from '../src/jobs/index.js';
import { createScriptDb } from './db-connection.js';
import { cliAbortSignal, cliJobLogger } from './job-cli.js';

async function main(argv: string[]): Promise<void> {
  const contentPriorFile = argv
    .find((argument) => argument.startsWith('--content-prior-file='))
    ?.slice('--content-prior-file='.length);
  const { db, close } = createScriptDb();
  try {
    await runRefreshClimbGrades({
      db,
      signal: cliAbortSignal(),
      log: cliJobLogger(),
      refit: argv.includes('--refit-coefficients'),
      dryRun: argv.includes('--dry-run'),
      validateOnly: argv.includes('--validate-only'),
      allowEmptyBacktest: argv.includes('--allow-empty-backtest'),
      publishCrossAngleEstimates: argv.includes('--publish-cross-angle-estimates'),
      contentPriorFile,
    });
  } finally {
    await close();
  }
}

main(process.argv.slice(2)).then(
  () => process.exit(0),
  (error: unknown) => {
    if (error instanceof GradeGatesFailedError) console.error(`[grades] ${error.message} — nothing written.`);
    else console.error('[grades] failed:', error);
    process.exit(1);
  },
);
