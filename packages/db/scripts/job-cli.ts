import type { JobLogger } from '../src/jobs/index.js';

/** GitHub's workflow-command escaping: a raw newline would end the annotation. */
function escapeAnnotation(text: string): string {
  return text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

/**
 * Console logger for the job CLIs. Under GitHub Actions a warning is printed as
 * a `::warning::` annotation, so a degraded run that still exits 0 (the
 * recommendations job without its PostHog key) shows on the run summary.
 */
export function cliJobLogger(environment: Readonly<Record<string, string | undefined>> = process.env): JobLogger {
  return {
    info: (message) => console.log(message),
    warn: (message, details) => {
      if (environment.GITHUB_ACTIONS !== 'true') {
        console.warn(message);
        return;
      }
      const title = details?.title
        ? ` title=${escapeAnnotation(details.title).replaceAll(':', '%3A').replaceAll(',', '%2C')}`
        : '';
      console.log(`::warning${title}::${escapeAnnotation(message)}`);
    },
  };
}

/**
 * The job's abort signal for a CLI run. The first SIGINT or SIGTERM aborts it:
 * the job stops at its next batch boundary and no half-written batch commits.
 * A second one exits at once.
 */
export function cliAbortSignal(): AbortSignal {
  const controller = new AbortController();
  const stop = (signal: NodeJS.Signals) => {
    if (controller.signal.aborted) process.exit(130);
    console.warn(`[job] ${signal}: stopping after the current batch (send again to exit now)`);
    controller.abort(new Error(`Interrupted by ${signal}`));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return controller.signal;
}
