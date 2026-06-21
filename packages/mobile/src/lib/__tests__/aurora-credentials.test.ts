import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ImportProgressEvent, ImportResult, StrippedAuroraExportData } from '@boardsesh/shared-schema';

const authenticatedFetchMock = vi.fn();

vi.mock('../auth-interceptor', () => ({
  authenticatedFetch: authenticatedFetchMock,
}));

vi.mock('expo-web-browser', () => ({
  openAuthSessionAsync: vi.fn(),
}));

const { streamAuroraImport } = await import('../aurora-credentials');

function result(overrides: Partial<ImportResult> = {}): ImportResult {
  return {
    ascents: { imported: 0, skipped: 0, failed: 0 },
    attempts: { imported: 0, skipped: 0, failed: 0 },
    circuits: { imported: 0, skipped: 0, failed: 0 },
    climbs: { imported: 0, skipped: 0, failed: 0 },
    unresolvedClimbs: [],
    unresolvedAscentClimbs: [],
    unresolvedAttemptClimbs: [],
    unresolvedCircuitClimbs: [],
    ...overrides,
  };
}

function exportData(overrides: Partial<StrippedAuroraExportData> = {}): StrippedAuroraExportData {
  return {
    user: { username: 'test-user' },
    ascents: [],
    attempts: [],
    circuits: [],
    climbs: [],
    ...overrides,
  };
}

function completeResponse(importResult: ImportResult): Response {
  return new Response(`${JSON.stringify({ type: 'complete', results: importResult })}\n`, { status: 200 });
}

describe('streamAuroraImport', () => {
  beforeEach(() => {
    authenticatedFetchMock.mockReset();
  });

  it('throws instead of reporting partial success when the first chunk fails', async () => {
    const events: ImportProgressEvent[] = [];
    authenticatedFetchMock.mockResolvedValueOnce(new Response('server error', { status: 500 }));

    await expect(
      streamAuroraImport('kilter', exportData({ ascents: [{ id: 1 }] }), (event) => events.push(event)),
    ).rejects.toThrow('import_failed');

    expect(events.some((event) => event.type === 'complete')).toBe(false);
  });

  it('reports partial success only after at least one chunk completes', async () => {
    const events: ImportProgressEvent[] = [];
    authenticatedFetchMock
      .mockResolvedValueOnce(completeResponse(result({ climbs: { imported: 1, skipped: 0, failed: 0 } })))
      .mockResolvedValueOnce(new Response('server error', { status: 500 }));

    await streamAuroraImport('kilter', exportData({ climbs: [{ id: 1 }], ascents: [{ id: 2 }] }), (event) =>
      events.push(event),
    );

    const complete = events.find((event): event is Extract<ImportProgressEvent, { type: 'complete' }> => {
      return event.type === 'complete';
    });
    expect(complete?.results.climbs.imported).toBe(1);
    expect(complete?.results.partialError).toBe('import_failed');
  });
});
