import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ImportProgressEvent, ImportResult } from '../json-import';

// ---------------------------------------------------------------------------
// Mock the GraphQL client module
// ---------------------------------------------------------------------------

const mockExecuteGraphQL = vi.fn();

vi.mock('@/app/lib/graphql/client', () => ({
  executeGraphQL: (...args: unknown[]) => mockExecuteGraphQL(...args),
}));

vi.mock('@/app/lib/graphql/operations/aurora-import', () => ({
  IMPORT_AURORA_JSON: 'mutation ImportAuroraJson($input: AuroraImportInput!) { importAuroraJson(input: $input) { ... } }',
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const emptyResult: ImportResult = {
  ascents: { imported: 0, skipped: 0, failed: 0 },
  attempts: { imported: 0, skipped: 0, failed: 0 },
  circuits: { imported: 0, skipped: 0, failed: 0 },
  unresolvedClimbs: [],
};

function makeGraphQLResponse(overrides: Partial<ImportResult> = {}, claimedUsername: string | null = null) {
  return {
    importAuroraJson: {
      ...emptyResult,
      ...overrides,
      claimedUsername,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('streamImport', () => {
  let streamImport: typeof import('../json-import-stream').streamImport;

  beforeEach(async () => {
    vi.restoreAllMocks();
    mockExecuteGraphQL.mockReset();
    const mod = await import('../json-import-stream');
    streamImport = mod.streamImport;
  });

  describe('GraphQL integration', () => {
    it('sends all data in a single GraphQL mutation', async () => {
      const ascents = Array.from({ length: 600 }, (_, i) => ({ id: i }));
      const result = { ascents: { imported: 600, skipped: 0, failed: 0 } };
      mockExecuteGraphQL.mockResolvedValueOnce(makeGraphQLResponse(result));

      const received: ImportProgressEvent[] = [];
      await streamImport('kilter', { user: { username: 'test' }, ascents }, (e) => received.push(e));

      // Single GraphQL call, no chunking
      expect(mockExecuteGraphQL).toHaveBeenCalledTimes(1);

      // Complete event should contain the result
      const completeEvent = received.find((e) => e.type === 'complete');
      expect(completeEvent).toBeDefined();
      if (completeEvent?.type === 'complete') {
        expect(completeEvent.results.ascents.imported).toBe(600);
      }
    });

    it('passes boardType and data in the GraphQL variables', async () => {
      mockExecuteGraphQL.mockResolvedValueOnce(makeGraphQLResponse());

      const data = {
        user: { username: 'climber123' },
        ascents: [{ id: 1 }],
        attempts: [{ id: 2 }],
        circuits: [{ name: 'Test' }],
      };

      await streamImport('tension', data, vi.fn());

      const [, variables] = mockExecuteGraphQL.mock.calls[0];
      expect(variables.input.boardType).toBe('tension');
      expect(variables.input.data.user.username).toBe('climber123');
      expect(variables.input.data.ascents).toHaveLength(1);
      expect(variables.input.data.attempts).toHaveLength(1);
      expect(variables.input.data.circuits).toHaveLength(1);
    });

    it('passes auth token to executeGraphQL', async () => {
      mockExecuteGraphQL.mockResolvedValueOnce(makeGraphQLResponse());

      await streamImport('kilter', { user: { username: 'test' } }, vi.fn(), 'my-auth-token');

      const [, , authToken] = mockExecuteGraphQL.mock.calls[0];
      expect(authToken).toBe('my-auth-token');
    });

    it('works without auth token (null)', async () => {
      mockExecuteGraphQL.mockResolvedValueOnce(makeGraphQLResponse());

      await streamImport('kilter', { user: { username: 'test' } }, vi.fn(), null);

      const [, , authToken] = mockExecuteGraphQL.mock.calls[0];
      expect(authToken).toBeNull();
    });

    it('defaults missing arrays to empty', async () => {
      mockExecuteGraphQL.mockResolvedValueOnce(makeGraphQLResponse());

      // Data with no ascents/attempts/circuits
      await streamImport('kilter', { user: { username: 'test' } }, vi.fn());

      const [, variables] = mockExecuteGraphQL.mock.calls[0];
      expect(variables.input.data.ascents).toEqual([]);
      expect(variables.input.data.attempts).toEqual([]);
      expect(variables.input.data.circuits).toEqual([]);
    });
  });

  describe('progress events', () => {
    it('emits a progress event before the GraphQL call', async () => {
      mockExecuteGraphQL.mockResolvedValueOnce(makeGraphQLResponse());

      const received: ImportProgressEvent[] = [];
      await streamImport('kilter', {
        user: { username: 'test' },
        ascents: [1, 2, 3],
        attempts: [4, 5],
      }, (e) => received.push(e));

      // First event should be a progress event
      expect(received[0]).toMatchObject({
        type: 'progress',
        step: 'resolving',
        message: 'Importing 5 items...',
      });
    });

    it('emits complete event with result on success', async () => {
      const result = {
        ascents: { imported: 10, skipped: 2, failed: 1 },
        attempts: { imported: 5, skipped: 0, failed: 0 },
        circuits: { imported: 1, skipped: 0, failed: 0 },
        unresolvedClimbs: ['unknown-climb'],
      };
      mockExecuteGraphQL.mockResolvedValueOnce(makeGraphQLResponse(result));

      const received: ImportProgressEvent[] = [];
      await streamImport('kilter', { user: { username: 'test' }, ascents: Array(13) }, (e) => received.push(e));

      const completeEvent = received.find((e) => e.type === 'complete');
      expect(completeEvent).toBeDefined();
      if (completeEvent?.type === 'complete') {
        expect(completeEvent.results.ascents.imported).toBe(10);
        expect(completeEvent.results.ascents.skipped).toBe(2);
        expect(completeEvent.results.ascents.failed).toBe(1);
        expect(completeEvent.results.attempts.imported).toBe(5);
        expect(completeEvent.results.circuits.imported).toBe(1);
        expect(completeEvent.results.unresolvedClimbs).toEqual(['unknown-climb']);
      }
    });
  });

  describe('error handling', () => {
    it('emits error event on GraphQL failure', async () => {
      mockExecuteGraphQL.mockRejectedValueOnce(new Error('Authentication required'));

      const received: ImportProgressEvent[] = [];
      await streamImport('kilter', { user: { username: 'test' } }, (e) => received.push(e));

      const errorEvent = received.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      if (errorEvent?.type === 'error') {
        expect(errorEvent.error).toBe('Authentication required');
      }
    });

    it('emits generic error message for non-Error exceptions', async () => {
      mockExecuteGraphQL.mockRejectedValueOnce('something went wrong');

      const received: ImportProgressEvent[] = [];
      await streamImport('kilter', { user: { username: 'test' } }, (e) => received.push(e));

      const errorEvent = received.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      if (errorEvent?.type === 'error') {
        expect(errorEvent.error).toBe('Import failed');
      }
    });

    it('emits error event on network failure', async () => {
      mockExecuteGraphQL.mockRejectedValueOnce(new Error('Failed to fetch'));

      const received: ImportProgressEvent[] = [];
      await streamImport('kilter', { user: { username: 'test' }, ascents: [1] }, (e) => received.push(e));

      const errorEvent = received.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      if (errorEvent?.type === 'error') {
        expect(errorEvent.error).toBe('Failed to fetch');
      }
    });
  });

  describe('large data sets', () => {
    it('sends 1000+ items in a single GraphQL call', async () => {
      const ascents = Array.from({ length: 500 }, (_, i) => ({ id: `a-${i}` }));
      const attempts = Array.from({ length: 400 }, (_, i) => ({ id: `t-${i}` }));
      const circuits = Array.from({ length: 150 }, (_, i) => ({ name: `c-${i}` }));

      mockExecuteGraphQL.mockResolvedValueOnce(makeGraphQLResponse({
        ascents: { imported: 500, skipped: 0, failed: 0 },
        attempts: { imported: 400, skipped: 0, failed: 0 },
        circuits: { imported: 150, skipped: 0, failed: 0 },
      }));

      const received: ImportProgressEvent[] = [];
      await streamImport('kilter', { user: { username: 'test' }, ascents, attempts, circuits }, (e) => received.push(e));

      // Must be a single GraphQL call regardless of item count
      expect(mockExecuteGraphQL).toHaveBeenCalledTimes(1);

      const completeEvent = received.find((e) => e.type === 'complete');
      expect(completeEvent).toBeDefined();
      if (completeEvent?.type === 'complete') {
        expect(completeEvent.results.ascents.imported).toBe(500);
        expect(completeEvent.results.attempts.imported).toBe(400);
        expect(completeEvent.results.circuits.imported).toBe(150);
      }
    });

    it('progress message shows correct total item count for large sets', async () => {
      const ascents = Array.from({ length: 800 }, (_, i) => ({ id: i }));
      const attempts = Array.from({ length: 300 }, (_, i) => ({ id: i }));

      mockExecuteGraphQL.mockResolvedValueOnce(makeGraphQLResponse());

      const received: ImportProgressEvent[] = [];
      await streamImport('kilter', { user: { username: 'test' }, ascents, attempts }, (e) => received.push(e));

      const progressEvent = received.find((e) => e.type === 'progress' && 'message' in e);
      expect(progressEvent).toBeDefined();
      if (progressEvent?.type === 'progress' && 'message' in progressEvent) {
        expect(progressEvent.message).toBe('Importing 1100 items...');
      }
    });
  });

  describe('event ordering', () => {
    it('emits only progress event before GraphQL resolves (no complete/error)', async () => {
      let resolveGraphQL: (value: unknown) => void;
      const graphQLPromise = new Promise((resolve) => { resolveGraphQL = resolve; });
      mockExecuteGraphQL.mockReturnValueOnce(graphQLPromise);

      const received: ImportProgressEvent[] = [];
      const importPromise = streamImport('kilter', { user: { username: 'test' }, ascents: [1, 2] }, (e) => received.push(e));

      // At this point, GraphQL has NOT resolved yet. We need to let microtasks run.
      await new Promise((r) => setTimeout(r, 0));

      // Only the progress event should have been emitted
      expect(received).toHaveLength(1);
      expect(received[0].type).toBe('progress');
      expect(received.some((e) => e.type === 'complete')).toBe(false);
      expect(received.some((e) => e.type === 'error')).toBe(false);

      // Now resolve and let it finish
      resolveGraphQL!(makeGraphQLResponse());
      await importPromise;

      expect(received).toHaveLength(2);
      expect(received[1].type).toBe('complete');
    });
  });

  describe('data wrapper structure', () => {
    it('wraps data with user, ascents, attempts, circuits keys in variables', async () => {
      mockExecuteGraphQL.mockResolvedValueOnce(makeGraphQLResponse());

      const data = {
        user: { username: 'climber', email_address: 'c@test.com', created_at: '2024-01-01' },
        ascents: [{ id: 1 }, { id: 2 }],
        attempts: [{ id: 3 }],
        circuits: [{ name: 'Red Circuit' }],
        // Extra fields that should not be passed through
        likes: [{ id: 99 }],
        follows: [{ id: 100 }],
      };

      await streamImport('tension', data, vi.fn());

      const [, variables] = mockExecuteGraphQL.mock.calls[0];
      const inputData = variables.input.data;

      // Should have exactly these four keys
      expect(inputData).toHaveProperty('user');
      expect(inputData).toHaveProperty('ascents');
      expect(inputData).toHaveProperty('attempts');
      expect(inputData).toHaveProperty('circuits');

      // User object should be passed through
      expect(inputData.user.username).toBe('climber');
      expect(inputData.user.email_address).toBe('c@test.com');

      // Arrays should match
      expect(inputData.ascents).toHaveLength(2);
      expect(inputData.attempts).toHaveLength(1);
      expect(inputData.circuits).toHaveLength(1);
    });
  });

  describe('undefined auth token', () => {
    it('passes undefined auth token when not provided', async () => {
      mockExecuteGraphQL.mockResolvedValueOnce(makeGraphQLResponse());

      // Call without authToken argument at all
      await streamImport('kilter', { user: { username: 'test' } }, vi.fn());

      const [, , authToken] = mockExecuteGraphQL.mock.calls[0];
      expect(authToken).toBeUndefined();
    });
  });
});
