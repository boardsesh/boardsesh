import type { JobContext, JobRun } from './types';

const MAX_ERROR_BODY_CHARS = 500;

/**
 * Statuses worth one retry: the edge answered, the app did not. Vercel serves
 * 502/503 during a deploy swap and when no instance is warm — a daily job that
 * lands in that window would otherwise page for a condition that clears in
 * seconds.
 *
 * 504 is deliberately not in the list. A gateway timeout means the request
 * reached the route and it was still working, so retrying stacks a second run
 * on top of the first rather than replacing a failed one.
 */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([502, 503]);

const DEFAULT_RETRY_DELAY_MS = 2_000;

export type TriggerWebCronOptions = {
  /** Wait before the single 502/503 retry. Shortened in tests. */
  readonly retryDelayMs?: number;
};

function abortReason(signal: AbortSignal, fallbackMessage: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(fallbackMessage);
}

/**
 * Sleeps, but gives up the moment the run is aborted — a retry wait must stay
 * inside the job's `timeoutMs` and must not hold up shutdown.
 */
function delay(durationMs: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal, 'aborted while waiting to retry'));
      return;
    }

    let timeoutHandle: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timeoutHandle);
      reject(abortReason(signal, 'aborted while waiting to retry'));
    };

    timeoutHandle = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, durationMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class WebCronRequestError extends Error {
  readonly status: number;

  constructor(path: string, status: number, body: string) {
    const truncatedBody = body.length > MAX_ERROR_BODY_CHARS ? `${body.slice(0, MAX_ERROR_BODY_CHARS)}…` : body;
    super(`${path} returned HTTP ${status}${truncatedBody ? `: ${truncatedBody}` : ''}`);
    this.name = 'WebCronRequestError';
    this.status = status;
  }
}

/**
 * Builds a job that triggers one of the web app's `/api/internal/*` cron
 * routes.
 *
 * The routes stay the single implementation — several of them touch Next-only
 * primitives (`unstable_cache` warm-up, `revalidateTag`) that a plain Node
 * process cannot reach — so the scheduler is a trigger, not a reimplementation.
 * The header is byte-identical to what Vercel auto-injects, which is what
 * `requireCronAuth` (packages/web/app/lib/auth/cron-auth.ts) validates.
 *
 * A 502/503 is retried once after {@link DEFAULT_RETRY_DELAY_MS}; everything
 * else fails on the first response. The whole thing — both attempts and the
 * wait between them — stays inside the job's `timeoutMs`.
 */
export function triggerWebCron(
  path: string,
  { retryDelayMs = DEFAULT_RETRY_DELAY_MS }: TriggerWebCronOptions = {},
): JobRun {
  return async (context: JobContext): Promise<unknown> => {
    const { config, logger, timeoutMs, shutdownSignal } = context;
    const url = `${config.webBaseUrl}${path}`;

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort(new Error(`${path} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const abortOnShutdown = () => controller.abort(new Error(`${path} aborted by shutdown`));
    if (shutdownSignal?.aborted) {
      abortOnShutdown();
    } else {
      shutdownSignal?.addEventListener('abort', abortOnShutdown, { once: true });
    }

    try {
      let retried = false;
      for (;;) {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${config.cronSecret}`,
            Accept: 'application/json',
          },
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          if (!retried && RETRYABLE_STATUSES.has(response.status)) {
            retried = true;
            logger.warn('web cron request failed on a retryable status; retrying once', {
              path,
              status: response.status,
              retryDelayMs,
            });
            await delay(retryDelayMs, controller.signal);
            continue;
          }
          throw new WebCronRequestError(path, response.status, body.trim());
        }

        const rawBody = await response.text();
        if (rawBody.trim() === '') {
          return null;
        }
        try {
          return JSON.parse(rawBody) as unknown;
        } catch {
          return rawBody.length > MAX_ERROR_BODY_CHARS ? `${rawBody.slice(0, MAX_ERROR_BODY_CHARS)}…` : rawBody;
        }
      }
    } finally {
      clearTimeout(timeoutHandle);
      shutdownSignal?.removeEventListener('abort', abortOnShutdown);
    }
  };
}
