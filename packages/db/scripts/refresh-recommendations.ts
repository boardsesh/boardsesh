/**
 * Nightly recommendations refresh: setter stats, PostHog send stats, cohort
 * playlists, weekly history catch-up. The job body is
 * `src/jobs/refresh-recommendations.ts`; the batch worker runs the same body.
 *
 * Run locally: `node --import tsx packages/db/scripts/refresh-recommendations.ts`
 * Env: DATABASE_URL (writable), optional POSTHOG_PERSONAL_API_KEY,
 * POSTHOG_PROJECT_ID, POSTHOG_HOST. Without the key the send stats are skipped.
 */
import { posthogConfigFromEnvironment, runRefreshRecommendations } from '../src/jobs/index.js';
import { createScriptDb } from './db-connection.js';
import { cliAbortSignal, cliJobLogger } from './job-cli.js';

async function main(): Promise<void> {
  const { db, close } = createScriptDb();
  try {
    await runRefreshRecommendations({
      db,
      signal: cliAbortSignal(),
      log: cliJobLogger(),
      posthog: posthogConfigFromEnvironment(process.env),
    });
  } finally {
    await close();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error('[recs] failed:', error);
    process.exit(1);
  },
);
