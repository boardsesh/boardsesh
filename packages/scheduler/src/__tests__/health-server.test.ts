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
    await expect(response.json()).resolves.toEqual({ status: 'ok', jobs: [jobStatus] });
  });

  it('reflects a failing job so ops can see it without reading logs', async () => {
    const baseUrl = await startServer(() => [{ ...jobStatus, lastError: 'HTTP 500', failureCount: 2 }]);

    const body = (await (await fetch(`${baseUrl}/health`)).json()) as { jobs: JobStatus[] };
    expect(body.jobs[0].lastError).toBe('HTTP 500');
    expect(body.jobs[0].failureCount).toBe(2);
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
