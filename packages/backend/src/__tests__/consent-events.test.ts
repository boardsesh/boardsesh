/**
 * Tests for the anonymous consent rejection event recorder.
 *
 * Verifies that:
 * - recordConsentRejection is callable WITHOUT authentication
 * - Invalid sources are rejected before any DB call
 * - The DB receives an insert with the supplied source
 * - DB failures are swallowed and the mutation returns false instead of throwing
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { consentEventsMutations } from '../graphql/resolvers/consentEvents/mutations';

const { mockDb, capturedCalls } = vi.hoisted(() => {
  const capturedCalls: Array<Record<string, unknown>> = [];

  const mockDb = {
    insert: vi.fn(),
  };

  return { mockDb, capturedCalls };
});

vi.mock('../db/client', () => ({
  db: mockDb,
}));

function makeAnonCtx(): ConnectionContext {
  return {
    connectionId: 'http-anon',
    sessionId: undefined,
    userId: undefined,
    isAuthenticated: false,
  };
}

function setupInsertMock(behavior: 'resolve' | 'reject' = 'resolve') {
  capturedCalls.length = 0;

  const valuesFn = vi.fn().mockImplementation((args: unknown) => {
    capturedCalls.push({ method: 'values', args });
    return behavior === 'resolve' ? Promise.resolve(undefined) : Promise.reject(new Error('boom'));
  });

  mockDb.insert.mockImplementation((table: unknown) => {
    capturedCalls.push({ method: 'insert', table });
    return { values: valuesFn };
  });
}

describe('recordConsentRejection mutation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedCalls.length = 0;
  });

  it('does not require authentication', async () => {
    setupInsertMock();

    const result = await consentEventsMutations.recordConsentRejection(
      {},
      { input: { source: 'banner' } },
      makeAnonCtx(),
    );

    expect(result).toBe(true);
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
  });

  it.each(['banner', 'dialog', 'settings'] as const)('accepts source "%s"', async (source) => {
    setupInsertMock();

    const result = await consentEventsMutations.recordConsentRejection({}, { input: { source } }, makeAnonCtx());

    expect(result).toBe(true);
    const valuesCall = capturedCalls.find((c) => c.method === 'values');
    expect(valuesCall).toBeDefined();
    expect((valuesCall!.args as { source: string }).source).toBe(source);
  });

  it('rejects sources outside the enum without touching the DB', async () => {
    setupInsertMock();

    await expect(
      consentEventsMutations.recordConsentRejection({}, { input: { source: 'evil-source' } }, makeAnonCtx()),
    ).rejects.toThrow();

    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('returns false (does not throw) when the DB write fails', async () => {
    setupInsertMock('reject');

    const result = await consentEventsMutations.recordConsentRejection(
      {},
      { input: { source: 'banner' } },
      makeAnonCtx(),
    );

    expect(result).toBe(false);
  });
});
