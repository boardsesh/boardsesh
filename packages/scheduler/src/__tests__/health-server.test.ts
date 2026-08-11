import { afterEach, describe, expect, it } from 'vitest';
import { createHealthServer, type HealthServer } from '../health-server';
import type { SchedulerLogger } from '../logger';
import type { JobStatus } from '../runner';

const silentLogger: SchedulerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const jobStatus: JobStatus = {
  name: 'cleanup',
  schedule: '0 5 * * *',
  timezone: 'UTC',
  scheduled: true,
  running: false,
  lastRunAt: '2026-08-11T05:00:00.000Z',
  lastSuccessAt: '2026-08-11T05:00:04.000Z',
  lastDurationMs: 4000,
  lastError: null,
  runCount: 1,
  failureCount: 0,
  skippedCount: 0,
};

let openServer: HealthServer | null = null;

afterEach(async () => {
  await openServer?.stop();
  openServer = null;
});

async function startServer(getStatus: () => JobStatus[]): Promise<string> {
  const server = createHealthServer({ port: 0, getStatus, logger: silentLogger });
  openServer = server;
  const port = await server.start();
  return `http://127.0.0.1:${port}`;
}

describe('createHealthServer', () => {
  it('serves the runner status map on GET /health', async () => {
    const baseUrl = await startServer(() => [jobStatus]);

    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toEqual({ status: 'ok', degraded: false, jobs: [jobStatus] });
  });

  it('reflects a failing job so ops can see it without reading logs', async () => {
    const baseUrl = await startServer(() => [{ ...jobStatus, lastError: 'HTTP 500', failureCount: 2 }]);

    const body = (await (await fetch(`${baseUrl}/health`)).json()) as { jobs: JobStatus[]; degraded: boolean };
    expect(body.jobs[0].lastError).toBe('HTTP 500');
    expect(body.jobs[0].failureCount).toBe(2);
    expect(body.degraded).toBe(true);
  });

  it('keeps /health at 200 while a job is failing — a restart cannot fix a bad secret', async () => {
    const baseUrl = await startServer(() => [{ ...jobStatus, lastError: 'HTTP 401' }]);

    // Railway polls /health; going red here would restart-loop the container
    // and wipe the lastError that says what actually broke.
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  });

  it('503s /health/jobs when a scheduled job last failed', async () => {
    const baseUrl = await startServer(() => [{ ...jobStatus, lastError: 'HTTP 401' }]);

    const response = await fetch(`${baseUrl}/health/jobs`);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { status: string; degraded: boolean };
    expect(body).toMatchObject({ status: 'degraded', degraded: true });
  });

  it('200s /health/jobs when every scheduled job is healthy', async () => {
    const baseUrl = await startServer(() => [jobStatus]);

    expect((await fetch(`${baseUrl}/health/jobs`)).status).toBe(200);
  });

  it('stays healthy before the first tick and ignores a disabled job failure', async () => {
    const neverRun = { ...jobStatus, lastRunAt: null, lastSuccessAt: null, lastDurationMs: null, runCount: 0 };
    const disabledAndBroken = { ...jobStatus, name: 'other', scheduled: false, lastError: 'HTTP 500' };
    const baseUrl = await startServer(() => [neverRun, disabledAndBroken]);

    expect((await fetch(`${baseUrl}/health/jobs`)).status).toBe(200);
  });

  it('ignores a query string on the health path', async () => {
    const baseUrl = await startServer(() => [jobStatus]);

    expect((await fetch(`${baseUrl}/health?verbose=1`)).status).toBe(200);
  });

  it('404s any other path', async () => {
    const baseUrl = await startServer(() => [jobStatus]);

    const response = await fetch(`${baseUrl}/anything-else`);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Not found' });
  });

  it('closes cleanly and stops accepting connections', async () => {
    const baseUrl = await startServer(() => [jobStatus]);
    const server = openServer;
    openServer = null;

    await server?.stop();
    await expect(fetch(`${baseUrl}/health`)).rejects.toThrow();
    // A second stop must be a no-op rather than hanging.
    await expect(server?.stop()).resolves.toBeUndefined();
  });
});
