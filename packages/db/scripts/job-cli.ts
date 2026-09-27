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
