import type { JobLogger } from '../src/jobs/index.js';

/**
 * Console logger for the job CLIs. Under GitHub Actions a warning is printed as
 * a `::warning::` annotation, so a degraded run that still exits 0 (the
 * recommendations job without its PostHog key) shows on the run summary.
 */
export function cliJobLogger(environment: Readonly<Record<string, string | undefined>> = process.env): JobLogger {
  return {
    info: (message) => console.log(message),
    warn: (message) => {
      if (environment.GITHUB_ACTIONS === 'true') console.log(`::warning::${message}`);
      else console.warn(message);
    },
  };
}
