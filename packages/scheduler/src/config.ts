/**
 * Scheduler environment parsing.
 *
 * Everything is read once at startup and fails fast: a missing `CRON_SECRET`
 * must surface as a crash-looping container, not as a 401 discovered days
 * later in the web logs.
 */
export type SchedulerConfig = {
  /** Base URL of the Next app the jobs are triggered against, no trailing slash. */
  readonly webBaseUrl: string;
  /** Shared secret sent as `Authorization: Bearer <secret>`; see cron-auth.ts. */
  readonly cronSecret: string;
  /** Port the health server listens on. */
  readonly port: number;
  /** Job names that must not be scheduled (env-flip kill switch). */
  readonly disabledJobs: readonly string[];
};

export class SchedulerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchedulerConfigError';
  }
}

const DEFAULT_WEB_BASE_URL = 'https://www.boardsesh.com';
const DEFAULT_PORT = 8080;

function parsePort(rawPort: string | undefined): number {
  if (rawPort === undefined || rawPort.trim() === '') {
    return DEFAULT_PORT;
  }

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SchedulerConfigError(`PORT must be an integer between 1 and 65535, got ${JSON.stringify(rawPort)}`);
  }
  return port;
}

function parseDisabledJobs(rawDisabledJobs: string | undefined): readonly string[] {
  if (!rawDisabledJobs) {
    return [];
  }
  return rawDisabledJobs
    .split(',')
    .map((jobName) => jobName.trim())
    .filter((jobName) => jobName.length > 0);
}

export function loadSchedulerConfig(env: NodeJS.ProcessEnv = process.env): SchedulerConfig {
  const cronSecret = env.CRON_SECRET?.trim();
  if (!cronSecret) {
    throw new SchedulerConfigError(
      'CRON_SECRET is required. Use the same value as the Vercel project env var — the remaining Vercel crons authenticate with it too.',
    );
  }

  // `BOARDSESH_WEB_URL` is already the backend → web convention
  // (packages/backend/src/lib/web-revalidate.ts); reuse the name rather than
  // inventing a second one.
  const rawWebBaseUrl = env.BOARDSESH_WEB_URL?.trim() || DEFAULT_WEB_BASE_URL;
  const webBaseUrl = rawWebBaseUrl.replace(/\/+$/, '');
  if (!/^https?:\/\//.test(webBaseUrl)) {
    throw new SchedulerConfigError(
      `BOARDSESH_WEB_URL must start with http:// or https://, got ${JSON.stringify(rawWebBaseUrl)}`,
    );
  }

  return {
    webBaseUrl,
    cronSecret,
    port: parsePort(env.PORT),
    disabledJobs: parseDisabledJobs(env.SCHEDULER_DISABLED_JOBS),
  };
}
