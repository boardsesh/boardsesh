/**
 * Nightly per-hold feature refresh (board_hold_features + the shadow
 * user_hold_classifications). The job body is `src/jobs/refresh-hold-features.ts`;
 * the batch worker runs the same body.
 *
 * Run locally: `node --import tsx packages/db/scripts/refresh-hold-features.ts --dry-run`
 * Flags: --dry-run (compute + log, write nothing) · --board=<name> (default kilter)
 *        · --no-shadow (skip the user_hold_classifications shadow-write).
 */
import { runRefreshHoldFeatures } from '../src/jobs/index.js';
import { createScriptDb } from './db-connection.js';
import { cliAbortSignal, cliJobLogger } from './job-cli.js';

async function main(argv: string[]): Promise<void> {
  const boardArgument = argv.find((argument) => argument.startsWith('--board='));
  const { db, close } = createScriptDb();
  try {
    await runRefreshHoldFeatures({
      db,
      signal: cliAbortSignal(),
      log: cliJobLogger(),
      board: boardArgument ? boardArgument.slice('--board='.length) : 'kilter',
      dryRun: argv.includes('--dry-run'),
      shadow: !argv.includes('--no-shadow'),
    });
  } finally {
    await close();
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error('[hold-features] failed:', error);
  process.exit(1);
});
