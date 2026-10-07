import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportSprayTraining, EXPORT_SPRAY_TRAINING_MUTATION, readExportResult } from '../jobs/export-spray-training';
import { loadSchedulerConfig } from '../config';

/**
 * The scheduler half of the spray training export (SW-20, #5471).
 *
 * As with the photo purge, the work runs in the backend; what this pins is the
 * HTTP contract and the result parse. Retirement on consent revocation and the
 * frozen split are asserted against a real database in
 * `packages/backend/src/__tests__/spray-training.test.ts`.
 */

const written = {
  exportId: '2026-10-07T08-00-00-000Z',
  imagesWritten: 4,
  exportsRetired: 1,
  skipped: false,
  skippedReason: null,
  versionsSkipped: 0,
  durationMs: 812,
};
const skipped = {
  exportId: null,
  imagesWritten: 0,
  exportsRetired: 0,
  skipped: true,
  skippedReason: 'UNCHANGED',
  versionsSkipped: 0,
  durationMs: 15,
};
const context = {
  config: loadSchedulerConfig({
    CRON_SECRET: 'test-secret',
    BOARDSESH_BACKEND_GRAPHQL_URL: 'https://backend.test/graphql',
  }),
  timeoutMs: 60_000,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
};
const success = (result: unknown = written) =>
  new Response(JSON.stringify({ data: { exportSprayTrainingDataset: result } }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readExportResult', () => {
  it('parses a written export and a skipped run', () => {
    expect(readExportResult({ data: { exportSprayTrainingDataset: written } })).toEqual(written);
    expect(readExportResult({ data: { exportSprayTrainingDataset: skipped } })).toEqual(skipped);
  });

  it('refuses GraphQL errors, a missing count, a non-boolean skipped and a numeric export id', () => {
    expect(() => readExportResult({ errors: [{ message: 'nope' }], data: null })).toThrow('GraphQL errors');
    expect(() =>
      readExportResult({ data: { exportSprayTrainingDataset: { ...written, imagesWritten: undefined } } }),
    ).toThrow('invalid result');
    expect(() => readExportResult({ data: { exportSprayTrainingDataset: { ...written, skipped: 'no' } } })).toThrow(
      'invalid result',
    );
    expect(() =>
      readExportResult({ data: { exportSprayTrainingDataset: { ...written, skippedReason: 'BUSY' } } }),
    ).toThrow('invalid result');
    expect(() => readExportResult({ data: { exportSprayTrainingDataset: { ...written, exportId: 7 } } })).toThrow(
      'invalid result',
    );
  });
});

describe('spray training export scheduler job', () => {
  it('posts the mutation and cron credentials directly to the backend', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(success());
    expect(await exportSprayTraining(context)).toEqual(written);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://backend.test/graphql',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' }),
        body: JSON.stringify({ query: EXPORT_SPRAY_TRAINING_MUTATION }),
      }),
    );
  });

  it('fails when another run holds the lease, so a stuck run is seen', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(success({ ...skipped, skippedReason: 'LOCKED' }));
    await expect(exportSprayTraining(context)).rejects.toThrow('holds the export lease');
  });

  it.each([401, 409, 500, 504])('fails without retrying HTTP %s', async (status) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unavailable', { status }));
    await expect(exportSprayTraining(context)).rejects.toThrow(`HTTP ${status}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([502, 503])('retries HTTP %s once — a deploy in flight is not a failed export', async (status) => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('unavailable', { status }))
      .mockResolvedValueOnce(success(skipped));
    expect(await exportSprayTraining(context)).toEqual(skipped);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
