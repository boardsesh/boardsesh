import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ImportProgressEvent, ImportResult } from '../json-import';
import type { streamImport as _streamImportType } from '../json-import-stream';

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers to build a mock ReadableStream from chunks
// ---------------------------------------------------------------------------

function createMockReadableStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index++;
      } else {
        controller.close();
      }
    },
  });
}

function mockFetchResponse(
  body: ReadableStream<Uint8Array> | null,
  opts: { ok?: boolean; status?: number; jsonBody?: unknown } = {},
) {
  const { ok = true, status = 200, jsonBody } = opts;
  return {
    ok,
    status,
    body,
    json: jsonBody !== undefined ? () => Promise.resolve(jsonBody) : () => Promise.reject(new Error('not json')),
  } as unknown as Response;
}

const emptyResult: ImportResult = {
  ascents: { imported: 0, skipped: 0, failed: 0 },
  attempts: { imported: 0, skipped: 0, failed: 0 },
  circuits: { imported: 0, skipped: 0, failed: 0 },
  climbs: { imported: 0, skipped: 0, failed: 0 },
  unresolvedClimbs: [],
  unresolvedAscentClimbs: [],
  unresolvedAttemptClimbs: [],
  unresolvedCircuitClimbs: [],
};

function makeResult(overrides: Partial<ImportResult> = {}): ImportResult {
  return { ...emptyResult, ...overrides };
}

/**
 * Creates a stream that returns a complete event with the given result.
 */
function makeCompleteStream(result: ImportResult): ReadableStream<Uint8Array> {
  const events: ImportProgressEvent[] = [{ type: 'complete', results: result }];
  return createMockReadableStream([events.map((e) => JSON.stringify(e)).join('\n') + '\n']);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('streamImport', () => {
  let streamImport: typeof _streamImportType;

  beforeEach(async () => {
    vi.restoreAllMocks();
    const mod = await import('../json-import-stream');
    streamImport = ((boardType, data, onEvent) =>
      mod.streamImport(boardType, data, onEvent, {
        backendUrl: 'https://backend.test',
        authToken: 'test-token',
      })) as typeof _streamImportType;
  });

  describe('basic streaming', () => {
    it('parses newline-delimited JSON events from a single-chunk import', async () => {
      const result = makeResult({ ascents: { imported: 5, skipped: 0, failed: 0 } });
      const events: ImportProgressEvent[] = [
        { type: 'progress', step: 'resolving', message: 'Resolving 5 climb names...' },
        { type: 'progress', step: 'dedup', message: 'Checking for duplicates...' },
        { type: 'progress', step: 'ascents', current: 5, total: 5 },
        { type: 'complete', results: result },
      ];

      const chunks = [events.map((e) => JSON.stringify(e)).join('\n') + '\n'];
      const stream = createMockReadableStream(chunks);
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockFetchResponse(stream));

      const received: ImportProgressEvent[] = [];
      // Small data set: single user with few ascents -> single chunk
      await streamImport('kilter', { user: { username: 'test' }, ascents: [1, 2, 3, 4, 5] }, (e) => received.push(e));

      // Should receive the batch progress event + forwarded progress events + complete
      const completeEvent = received.find((e) => e.type === 'complete');
      expect(completeEvent).toBeDefined();
    });

    it('handles events split across multiple stream chunks', async () => {
      const event1 = JSON.stringify({
        type: 'progress',
        step: 'resolving',
        message: 'hi',
      } satisfies ImportProgressEvent);
      const complete = JSON.stringify({
        type: 'complete',
        results: emptyResult,
      } satisfies ImportProgressEvent);

      // Split event1 across two chunks
      const half = Math.floor(event1.length / 2);
      const streamChunks = [event1.slice(0, half), event1.slice(half) + '\n', complete + '\n'];

      const stream = createMockReadableStream(streamChunks);
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockFetchResponse(stream));

      const received: ImportProgressEvent[] = [];
      await streamImport('tension', { user: { username: 'test' } }, (e) => received.push(e));

      const progressEvents = received.filter((e) => e.type === 'progress' && e.step === 'resolving');
      expect(progressEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('processes remaining buffer data after stream ends (no trailing newline)', async () => {
      const result = makeResult({ ascents: { imported: 1, skipped: 0, failed: 0 } });
      const completeEvent: ImportProgressEvent = { type: 'complete', results: result };
      // No trailing newline — data stays in buffer until stream ends
      const stream = createMockReadableStream([JSON.stringify(completeEvent)]);
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockFetchResponse(stream));

      const received: ImportProgressEvent[] = [];
      await streamImport('kilter', { user: { username: 'test' }, ascents: [1] }, (e) => received.push(e));

      const complete = received.find((e) => e.type === 'complete');
      expect(complete).toBeDefined();
    });
  });

  describe('error handling', () => {
    it('captures non-ok response with JSON error body as partialError', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        mockFetchResponse(null, {
          ok: false,
          status: 400,
          jsonBody: { error: 'Bad request data' },
        }),
      );

      const received: ImportProgressEvent[] = [];
      await streamImport('kilter', { user: { username: 'test' } }, (e) => received.push(e));

      const complete = received.find((e) => e.type === 'complete');
      expect(complete).toBeDefined();
      if (complete?.type === 'complete') {
        expect(complete.results.partialError).toBe('Bad request data');
      }
    });

    it('captures generic message on non-ok response with non-JSON body as partialError', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error('not json')),
        body: null,
      } as unknown as Response);

      const received: ImportProgressEvent[] = [];
      await streamImport('kilter', { user: { username: 'test' } }, (e) => received.push(e));

      const complete = received.find((e) => e.type === 'complete');
      expect(complete).toBeDefined();
      if (complete?.type === 'complete') {
        expect(complete.results.partialError).toBe('Import failed');
      }
    });

    it('captures missing response body as partialError', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockFetchResponse(null));

      const received: ImportProgressEvent[] = [];
      await streamImport('kilter', { user: { username: 'test' } }, (e) => received.push(e));

      const complete = received.find((e) => e.type === 'complete');
      expect(complete).toBeDefined();
      if (complete?.type === 'complete') {
        expect(complete.results.partialError).toBe('No response body');
      }
    });

    it('skips malformed JSON lines without throwing', async () => {
      const validEvent: ImportProgressEvent = {
        type: 'progress',
        step: 'resolving',
        message: 'ok',
      };
      const completeEvent: ImportProgressEvent = { type: 'complete', results: emptyResult };
      const streamChunks = [
        'not valid json\n' + JSON.stringify(validEvent) + '\n' + JSON.stringify(completeEvent) + '\n',
      ];
      const stream = createMockReadableStream(streamChunks);
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockFetchResponse(stream));

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const received: ImportProgressEvent[] = [];
      await streamImport('kilter', { user: { username: 'test' } }, (e) => received.push(e));

      const progressEvents = received.filter((e) => e.type === 'progress' && e.step === 'resolving');
      expect(progressEvents.length).toBeGreaterThanOrEqual(1);
      expect(warnSpy).toHaveBeenCalledWith('Failed to parse import stream line:', 'not valid json');
    });

    it('captures server error events as partialError', async () => {
      const errorEvent: ImportProgressEvent = {
        type: 'error',
        error: 'Database connection failed',
      };
      const stream = createMockReadableStream([JSON.stringify(errorEvent) + '\n']);
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockFetchResponse(stream));

      const received: ImportProgressEvent[] = [];
      await streamImport('kilter', { user: { username: 'test' }, ascents: [1] }, (e) => received.push(e));

      const complete = received.find((e) => e.type === 'complete');
      expect(complete).toBeDefined();
      if (complete?.type === 'complete') {
        expect(complete.results.partialError).toBe('Database connection failed');
      }
    });

    it('skips malformed JSON in remaining buffer without throwing', async () => {
      // First chunk completes fine, but buffer has garbage
      const completeEvent: ImportProgressEvent = { type: 'complete', results: emptyResult };
      const stream = createMockReadableStream([JSON.stringify(completeEvent) + '\nnot json at all']);
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockFetchResponse(stream));

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const received: ImportProgressEvent[] = [];
      await streamImport('kilter', { user: { username: 'test' } }, (e) => received.push(e));

      expect(warnSpy).toHaveBeenCalledWith('Failed to parse import stream buffer:', 'not json at all');
    });

    it('captures interruption when server stream ends without a complete or error event', async () => {
      // Stream with only progress events, no complete/error
      const progressOnly: ImportProgressEvent = {
        type: 'progress',
        step: 'resolving',
        message: 'working...',
      };
      const stream = createMockReadableStream([JSON.stringify(progressOnly) + '\n']);
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockFetchResponse(stream));

      const received: ImportProgressEvent[] = [];
      await streamImport('kilter', { user: { username: 'test' }, ascents: [1] }, (e) => received.push(e));

      const complete = received.find((e) => e.type === 'complete');
      expect(complete).toBeDefined();
      if (complete?.type === 'complete') {
        expect(complete.results.partialError).toContain('Import was interrupted');
      }
    });

    it('captures interruption when server stream is completely empty', async () => {
      const stream = createMockReadableStream([]);
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockFetchResponse(stream));

      const received: ImportProgressEvent[] = [];
      await streamImport('kilter', { user: { username: 'test' } }, (e) => received.push(e));

      const complete = received.find((e) => e.type === 'complete');
      expect(complete).toBeDefined();
      if (complete?.type === 'complete') {
        expect(complete.results.partialError).toContain('Import was interrupted');
      }
    });
  });

  describe('chunking', () => {
    it('sends multiple requests when data exceeds chunk size', async () => {
      // 600 ascents should produce 2 chunks (500 + 100)
      const ascents = Array.from({ length: 600 }, (_, i) => ({ id: i }));
      const result = makeResult({ ascents: { imported: 500, skipped: 0, failed: 0 } });
      const result2 = makeResult({ ascents: { imported: 100, skipped: 0, failed: 0 } });

      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(mockFetchResponse(makeCompleteStream(result)))
        .mockResolvedValueOnce(mockFetchResponse(makeCompleteStream(result2)));

      const received: ImportProgressEvent[] = [];
      await streamImport('kilter', { user: { username: 'test' }, ascents }, (e) => received.push(e));

      // Should have made 2 fetch calls (2 ascent chunks)
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      // First chunk should skip finalization.
      const firstBody = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
      expect(firstBody.skipFinalization).toBe(true);
      expect(firstBody.data.ascents).toHaveLength(500);

      // Last chunk should run finalization.
      const lastBody = JSON.parse(fetchSpy.mock.calls[1][1]!.body as string);
      expect(lastBody.skipFinalization).toBe(false);
      expect(lastBody.data.ascents).toHaveLength(100);
    });

    it('merges results across chunks', async () => {
      const ascents = Array.from({ length: 600 }, (_, i) => ({ id: i }));
      const result1 = makeResult({
        ascents: { imported: 400, skipped: 50, failed: 50 },
        unresolvedClimbs: ['climb-a'],
      });
      const result2 = makeResult({
        ascents: { imported: 80, skipped: 10, failed: 10 },
        unresolvedClimbs: ['climb-b', 'climb-a'], // duplicate should be deduped
      });

      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(mockFetchResponse(makeCompleteStream(result1)))
        .mockResolvedValueOnce(mockFetchResponse(makeCompleteStream(result2)));

      const received: ImportProgressEvent[] = [];
      await streamImport('kilter', { user: { username: 'test' }, ascents }, (e) => received.push(e));

      const completeEvent = received.find((e) => e.type === 'complete');
      expect(completeEvent).toBeDefined();
      if (completeEvent?.type === 'complete') {
        expect(completeEvent.results.ascents.imported).toBe(480);
        expect(completeEvent.results.ascents.skipped).toBe(60);
        expect(completeEvent.results.ascents.failed).toBe(60);
        // Unresolved climbs should be deduped
        expect(completeEvent.results.unresolvedClimbs).toEqual(['climb-a', 'climb-b']);
      }
    });

    it('sends ascents and attempts in separate chunk groups', async () => {
      const ascents = Array.from({ length: 100 }, (_, i) => ({ id: i }));
      const attempts = Array.from({ length: 100 }, (_, i) => ({ id: i }));

      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          mockFetchResponse(makeCompleteStream(makeResult({ ascents: { imported: 100, skipped: 0, failed: 0 } }))),
        )
        .mockResolvedValueOnce(
          mockFetchResponse(makeCompleteStream(makeResult({ attempts: { imported: 100, skipped: 0, failed: 0 } }))),
        );

      await streamImport('kilter', { user: { username: 'test' }, ascents, attempts }, vi.fn());

      expect(fetchSpy).toHaveBeenCalledTimes(2);

      // First call: ascents only
      const body1 = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
      expect(body1.data.ascents).toHaveLength(100);
      expect(body1.data.attempts).toHaveLength(0);

      // Second call: attempts only
      const body2 = JSON.parse(fetchSpy.mock.calls[1][1]!.body as string);
      expect(body2.data.ascents).toHaveLength(0);
      expect(body2.data.attempts).toHaveLength(100);
    });

    it('sends circuits in the last chunk', async () => {
      const ascents = Array.from({ length: 100 }, (_, i) => ({ id: i }));
      const circuits = [{ name: 'My Circuit', color: 'ff0000', created_at: '2024-01-01', climbs: [] }];

      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(mockFetchResponse(makeCompleteStream(emptyResult)))
        .mockResolvedValueOnce(mockFetchResponse(makeCompleteStream(emptyResult)));

      await streamImport('kilter', { user: { username: 'test' }, ascents, circuits }, vi.fn());

      expect(fetchSpy).toHaveBeenCalledTimes(2);

      // Last call should contain circuits and run finalization.
      const lastBody = JSON.parse(fetchSpy.mock.calls[1][1]!.body as string);
      expect(lastBody.data.circuits).toHaveLength(1);
      expect(lastBody.skipFinalization).toBe(false);
    });

    it('sends a single request for small data sets', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(mockFetchResponse(makeCompleteStream(emptyResult)));

      await streamImport(
        'kilter',
        {
          user: { username: 'test' },
          ascents: [{ id: 1 }],
          attempts: [],
          circuits: [],
        },
        vi.fn(),
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
      expect(body.skipFinalization).toBe(false);
    });

    it('handles empty data by sending a single empty chunk', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(mockFetchResponse(makeCompleteStream(emptyResult)));

      await streamImport('kilter', { user: { username: 'test' } }, vi.fn());

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
      expect(body.skipFinalization).toBe(false);
      expect(body.data.ascents).toHaveLength(0);
      expect(body.data.attempts).toHaveLength(0);
      expect(body.data.circuits).toHaveLength(0);
    });

    it('captures chunk error as partialError and stops sending remaining chunks', async () => {
      // 1500 ascents → 3 chunks (500 + 500 + 500). First succeeds, second errors;
      // third must NOT be sent.
      const ascents = Array.from({ length: 1500 }, (_, i) => ({ id: i }));

      const firstResult = makeResult({ ascents: { imported: 500, skipped: 0, failed: 0 } });
      const errorEvent: ImportProgressEvent = { type: 'error', error: 'Server overloaded' };
      const errorStream = createMockReadableStream([JSON.stringify(errorEvent) + '\n']);

      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(mockFetchResponse(makeCompleteStream(firstResult)))
        .mockResolvedValueOnce(mockFetchResponse(errorStream));

      const received: ImportProgressEvent[] = [];
      await streamImport('kilter', { user: { username: 'test' }, ascents }, (e) => received.push(e));

      // No third request — the loop bailed
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      const complete = received.find((e) => e.type === 'complete');
      expect(complete).toBeDefined();
      if (complete?.type === 'complete') {
        expect(complete.results.partialError).toBe('Server overloaded');
        // First chunk's imports survive in the merged result
        expect(complete.results.ascents.imported).toBe(500);
      }
    });

    it('joins partialError from a server-returned result with a later chunk error', async () => {
      // First chunk returns a complete result that already carries a
      // partialError (e.g. the server-side flash-correction step failed).
      // Second chunk fails outright. Both messages must survive the merge so
      // we don't lose diagnostics in Sentry or the UI banner.
      const ascents = Array.from({ length: 1000 }, (_, i) => ({ id: i }));

      const firstResult = makeResult({
        ascents: { imported: 500, skipped: 0, failed: 0 },
        partialError: 'Flash status correction failed',
      });
      const errorEvent: ImportProgressEvent = { type: 'error', error: 'Server overloaded' };
      const errorStream = createMockReadableStream([JSON.stringify(errorEvent) + '\n']);

      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(mockFetchResponse(makeCompleteStream(firstResult)))
        .mockResolvedValueOnce(mockFetchResponse(errorStream));

      const received: ImportProgressEvent[] = [];
      await streamImport('kilter', { user: { username: 'test' }, ascents }, (e) => received.push(e));

      const complete = received.find((e) => e.type === 'complete');
      expect(complete).toBeDefined();
      if (complete?.type === 'complete') {
        expect(complete.results.partialError).toContain('Flash status correction failed');
        expect(complete.results.partialError).toContain('Server overloaded');
      }
    });

    it('merges per-source unresolved arrays across chunks with Set-dedup', async () => {
      const ascents = Array.from({ length: 600 }, (_, i) => ({ id: i }));
      const result1 = makeResult({
        unresolvedAscentClimbs: ['A1', 'A2'],
        unresolvedAttemptClimbs: ['T1'],
        unresolvedCircuitClimbs: ['C1'],
      });
      const result2 = makeResult({
        unresolvedAscentClimbs: ['A2', 'A3'],
        unresolvedAttemptClimbs: ['T1', 'T2'],
        unresolvedCircuitClimbs: ['C2'],
      });

      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(mockFetchResponse(makeCompleteStream(result1)))
        .mockResolvedValueOnce(mockFetchResponse(makeCompleteStream(result2)));

      const received: ImportProgressEvent[] = [];
      await streamImport('kilter', { user: { username: 'test' }, ascents }, (e) => received.push(e));

      const complete = received.find((e) => e.type === 'complete');
      expect(complete).toBeDefined();
      if (complete?.type === 'complete') {
        expect(complete.results.unresolvedAscentClimbs).toEqual(['A1', 'A2', 'A3']);
        expect(complete.results.unresolvedAttemptClimbs).toEqual(['T1', 'T2']);
        expect(complete.results.unresolvedCircuitClimbs).toEqual(['C1', 'C2']);
      }
    });
  });

  describe('new Aurora boards (decoy, touchstone, grasshopper, soill)', () => {
    it('passes decoy boardType to the import endpoint', async () => {
      const stream = makeCompleteStream(emptyResult);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockFetchResponse(stream));

      await streamImport('decoy', { user: { username: 'test' }, ascents: [{ id: 1 }] }, vi.fn());

      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.boardType).toBe('decoy');
    });

    it('passes touchstone boardType to the import endpoint', async () => {
      const stream = makeCompleteStream(emptyResult);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockFetchResponse(stream));

      await streamImport('touchstone', { user: { username: 'test' } }, vi.fn());

      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.boardType).toBe('touchstone');
    });

    it('passes grasshopper boardType to the import endpoint', async () => {
      const stream = makeCompleteStream(emptyResult);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockFetchResponse(stream));

      await streamImport('grasshopper', { user: { username: 'test' } }, vi.fn());

      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.boardType).toBe('grasshopper');
    });

    it('passes soill boardType to the import endpoint', async () => {
      const stream = makeCompleteStream(emptyResult);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockFetchResponse(stream));

      await streamImport('soill', { user: { username: 'test' } }, vi.fn());

      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.boardType).toBe('soill');
    });
  });
});
