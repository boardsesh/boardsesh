import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SchedulerConfig } from '../config';
import type { SchedulerLogger } from '../logger';
import { triggerWebCron, WebCronRequestError } from '../jobs/trigger-web-cron';

const config: SchedulerConfig = {
  webBaseUrl: 'https://web.test',
  backendGraphqlUrl: 'https://backend.test/graphql',
  cronSecret: 'super-secret',
  port: 8080,
  disabledJobs: [],
};

const silentLogger: SchedulerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const context = (
  overrides: Partial<{ timeoutMs: number; shutdownSignal: AbortSignal; logger: SchedulerLogger }> = {},
) => ({
  config,
  logger: silentLogger,
  timeoutMs: 120_000,
  ...overrides,
});

describe('triggerWebCron', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls the web route with the bearer header requireCronAuth expects', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ feedItemsDeleted: 3 }), { status: 200 }));

    const result = await triggerWebCron('/api/internal/cleanup')(context());

    expect(result).toEqual({ feedItemsDeleted: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = fetchMock.mock.calls[0];
    expect(requestUrl).toBe('https://web.test/api/internal/cleanup');
    const headers = (requestInit?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer super-secret');
    expect(requestInit?.method).toBe('GET');
  });

  it('throws with the status on a 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    );

    await expect(triggerWebCron('/api/internal/cleanup')(context())).rejects.toThrow(WebCronRequestError);
    await expect(triggerWebCron('/api/internal/cleanup')(context())).rejects.toThrow(/HTTP 401/);
  });

  it('throws with the status and body on a 500', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Cleanup failed', { status: 500 }));

    await expect(triggerWebCron('/api/internal/cleanup')(context())).rejects.toThrow(/HTTP 500: Cleanup failed/);
  });

  it('truncates a huge error body instead of logging the whole page', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x'.repeat(5000), { status: 500 }));

    const error = await triggerWebCron('/api/internal/cleanup')(context()).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(WebCronRequestError);
    expect((error as Error).message.length).toBeLessThan(600);
  });

  it('aborts a hung request at timeoutMs instead of blocking the tick forever', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );

    const pending = triggerWebCron('/api/internal/cleanup')(context({ timeoutMs: 1_000 }));
    const assertion = expect(pending).rejects.toThrow(/aborted/);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it('aborts in flight when the process is shutting down', async () => {
    const shutdownController = new AbortController();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );

    const pending = triggerWebCron('/api/internal/cleanup')(context({ shutdownSignal: shutdownController.signal }));
    const assertion = expect(pending).rejects.toThrow(/aborted/);
    shutdownController.abort(new Error('stopping'));
    await assertion;
  });

  it('returns null for an empty 200 body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));

    await expect(triggerWebCron('/api/internal/cleanup')(context())).resolves.toBeNull();
  });

  it('retries a 503 once and reports the second attempt as the result', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('no healthy upstream', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ feedItemsDeleted: 1 }), { status: 200 }));
    const warnings: string[] = [];

    const result = await triggerWebCron('/api/internal/cleanup', { retryDelayMs: 1 })(
      context({ logger: { ...silentLogger, warn: (message) => warnings.push(message) } }),
    );

    expect(result).toEqual({ feedItemsDeleted: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warnings).toEqual(['web cron request failed on a retryable status; retrying once']);
  });

  it('retries a 502 exactly once before giving up', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response('Bad gateway', { status: 502 })));

    await expect(triggerWebCron('/api/internal/cleanup', { retryDelayMs: 1 })(context())).rejects.toThrow(
      /HTTP 502: Bad gateway/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a status the app itself produced', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response('Cleanup failed', { status: 500 })));

    await expect(triggerWebCron('/api/internal/cleanup', { retryDelayMs: 1 })(context())).rejects.toThrow(/HTTP 500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('abandons the retry wait when the process is shutting down', async () => {
    const shutdownController = new AbortController();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response('no healthy upstream', { status: 503 })));
    // Shut down at the exact moment the retry is announced, so the run is
    // waiting out a minute-long backoff it must not finish.
    const logger: SchedulerLogger = { ...silentLogger, warn: () => shutdownController.abort() };

    await expect(
      triggerWebCron('/api/internal/cleanup', { retryDelayMs: 60_000 })(
        context({ shutdownSignal: shutdownController.signal, logger }),
      ),
    ).rejects.toThrow(/aborted by shutdown/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
