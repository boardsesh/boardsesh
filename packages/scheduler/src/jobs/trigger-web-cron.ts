import type { JobContext, JobRun } from './types';

const MAX_ERROR_BODY_CHARS = 500;

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
 */
export function triggerWebCron(path: string): JobRun {
  return async (context: JobContext): Promise<unknown> => {
    const { config, timeoutMs, shutdownSignal } = context;
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
    } finally {
      clearTimeout(timeoutHandle);
      shutdownSignal?.removeEventListener('abort', abortOnShutdown);
    }
  };
}
