import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const { claims, mockDb, retrieve, list, withSupportOperation, deleteWhere, claimLimit, logger } = vi.hoisted(() => ({
  claims: [] as Array<{
    id: string;
    checkoutSessionId: string | null;
    createdAt: Date;
    checkoutExpiresAt: Date | null;
  }>,
  mockDb: { select: vi.fn(), delete: vi.fn() },
  retrieve: vi.fn(),
  list: vi.fn(),
  withSupportOperation: vi.fn(),
  deleteWhere: vi.fn(),
  claimLimit: vi.fn(),
  logger: { warn: vi.fn() },
}));
vi.mock('../db/client', () => ({ db: mockDb }));
vi.mock('../utils/logger', () => ({ logger }));
vi.mock('./stripe-support-operation', () => ({ withSupportOperation }));
vi.mock('./stripe-support', () => ({
  isStripeSupportConfigured: () => true,
  getStripeClient: () => ({ checkout: { sessions: { retrieve, list } } }),
}));

import { reconcileExpiredSupportClaims } from './reconcile-support-claims';

beforeEach(() => {
  vi.clearAllMocks();
  claims.splice(0, claims.length, {
    id: 'claim-1',
    checkoutSessionId: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    checkoutExpiresAt: new Date('2026-10-02T00:00:00Z'),
  });
  withSupportOperation.mockImplementation(
    async (
      _userId: string,
      _kind: string,
      prepare: (transaction: typeof mockDb) => Promise<unknown>,
      perform: (prepared: unknown, operationId: string) => Promise<unknown>,
      finish: (transaction: typeof mockDb, prepared: unknown, networkResult: unknown) => Promise<void>,
    ) => {
      const prepared = await prepare(mockDb);
      const networkResult = await perform(prepared, 'operation-1');
      return finish(mockDb, prepared, networkResult);
    },
  );
  claimLimit.mockImplementation(async () => claims);
  mockDb.select.mockReturnValue({
    from: () => ({ where: () => ({ orderBy: () => ({ limit: claimLimit }) }) }),
  });
  mockDb.delete.mockReturnValue({ where: deleteWhere });
  deleteWhere.mockResolvedValue(undefined);
  list.mockReset().mockResolvedValue({ data: [], has_more: false });
  retrieve.mockReset();
});

describe('expired support claim reconciliation', () => {
  it('scans Stripe between preparation and finalization, with no transaction open', async () => {
    const phases: string[] = [];
    withSupportOperation.mockImplementation(
      async (
        _userId: string,
        _kind: string,
        prepare: (transaction: typeof mockDb) => Promise<unknown>,
        perform: (prepared: unknown, operationId: string) => Promise<unknown>,
        finish: (transaction: typeof mockDb, prepared: unknown, networkResult: unknown) => Promise<void>,
      ) => {
        phases.push('prepare');
        const prepared = await prepare(mockDb);
        phases.push('outside transaction');
        const networkResult = await perform(prepared, 'operation-1');
        phases.push('finish');
        return finish(mockDb, prepared, networkResult);
      },
    );
    list.mockImplementation(async () => {
      expect(phases.at(-1)).toBe('outside transaction');
      expect(deleteWhere).not.toHaveBeenCalled();
      return { data: [], has_more: false };
    });
    deleteWhere.mockImplementation(async () => expect(phases.at(-1)).toBe('finish'));
    await reconcileExpiredSupportClaims('user-1');
    expect(phases).toEqual(['prepare', 'outside transaction', 'finish']);
    expect(deleteWhere).toHaveBeenCalledOnce();
  });

  it('binds final deletion to the inspected account, expiry and session', async () => {
    claims[0].checkoutSessionId = 'cs_1';
    retrieve.mockResolvedValue({ client_reference_id: 'claim-1', status: 'expired' });
    await reconcileExpiredSupportClaims('user-1');
    const predicate = deleteWhere.mock.calls[0][0] as SQL;
    const { sql, params } = new PgDialect().sqlToQuery(predicate);
    expect(sql).toContain('"checkout_session_id" =');
    expect(params).toContain('cs_1');
    expect(params).toContain('claim-1');
    expect(params).toContain('user-1');
    expect(params).toContain('2026-10-02T00:00:00.000Z');
  });

  it('does no Stripe work when the account reservation is missing', async () => {
    withSupportOperation.mockResolvedValueOnce(null);
    await reconcileExpiredSupportClaims('user-1');
    expect(list).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it('releases an abandoned fixed-expiry claim only after exhausting the bounded Stripe scan', async () => {
    list
      .mockResolvedValueOnce({
        data: [{ id: 'cs_other', client_reference_id: 'other', status: 'complete' }],
        has_more: true,
      })
      .mockResolvedValueOnce({ data: [], has_more: false });
    await reconcileExpiredSupportClaims('user-1');
    expect(withSupportOperation).toHaveBeenCalledWith(
      'user-1',
      'reconciling',
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
    expect(claimLimit).toHaveBeenCalledWith(10);
    expect(list).toHaveBeenNthCalledWith(
      1,
      {
        limit: 100,
        created: { gte: Date.parse('2026-09-30T23:59:00Z') / 1000, lte: Date.parse('2026-10-02T00:00:00Z') / 1000 },
      },
      expect.objectContaining({ timeout: expect.any(Number), maxNetworkRetries: 0 }),
    );
    expect(list.mock.calls[1][0].starting_after).toBe('cs_other');
    expect(deleteWhere).toHaveBeenCalledTimes(1);
  });

  it.each(['open', 'complete', null])('retains a matching %s session for webhook reconciliation', async (status) => {
    list.mockResolvedValue({ data: [{ id: 'cs_1', client_reference_id: 'claim-1', status }], has_more: false });
    await reconcileExpiredSupportClaims('user-1');
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it('keeps scanning after an expired match to avoid discarding another paid session', async () => {
    list
      .mockResolvedValueOnce({
        data: [{ id: 'cs_expired', client_reference_id: 'claim-1', status: 'expired' }],
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: [{ id: 'cs_paid', client_reference_id: 'claim-1', status: 'complete' }],
        has_more: false,
      });
    await reconcileExpiredSupportClaims('user-1');
    expect(list).toHaveBeenCalledTimes(2);
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it('releases a known expired session after verifying its claim reference', async () => {
    claims[0].checkoutSessionId = 'cs_1';
    retrieve.mockResolvedValue({ client_reference_id: 'claim-1', status: 'expired' });
    await reconcileExpiredSupportClaims('user-1');
    expect(retrieve).toHaveBeenCalledWith(
      'cs_1',
      expect.objectContaining({ timeout: expect.any(Number), maxNetworkRetries: 0 }),
    );
    expect(deleteWhere).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
  });

  it('retains a known session whose reference does not match', async () => {
    claims[0].checkoutSessionId = 'cs_1';
    retrieve.mockResolvedValue({ client_reference_id: 'other', status: 'expired' });
    await reconcileExpiredSupportClaims('user-1');
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it('retains claims when the scan reaches its page bound', async () => {
    list.mockResolvedValue({
      data: [{ id: 'cs_other', client_reference_id: 'other', status: 'expired' }],
      has_more: true,
    });
    await reconcileExpiredSupportClaims('user-1');
    expect(list).toHaveBeenCalledTimes(10);
    expect(deleteWhere).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('truncated'),
      expect.objectContaining({ sessionLimit: 1000 }),
    );
  });

  it('logs and retains a claim when Stripe returns an empty unfinished page', async () => {
    list.mockResolvedValue({ data: [], has_more: true });
    await reconcileExpiredSupportClaims('user-1');
    expect(deleteWhere).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('empty Stripe page'), { claimId: 'claim-1' });
  });

  it('stops pagination after the shared reconciliation time budget', async () => {
    vi.useFakeTimers();
    try {
      list.mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + 16_000);
        return { data: [{ id: 'cs_other', client_reference_id: 'other', status: 'expired' }], has_more: true };
      });
      await reconcileExpiredSupportClaims('user-1');
      expect(list).toHaveBeenCalledOnce();
      expect(deleteWhere).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('reconciliation failed'),
        expect.objectContaining({
          error: expect.objectContaining({ message: 'Stripe reconciliation time budget exhausted' }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains claims on Stripe lookup errors', async () => {
    list.mockRejectedValue(new Error('Stripe unavailable'));
    await reconcileExpiredSupportClaims('user-1');
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it('never clears a legacy claim without a fixed expiry', async () => {
    claims[0].checkoutExpiresAt = null;
    await reconcileExpiredSupportClaims('user-1');
    expect(list).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it('does not swallow a database deletion failure', async () => {
    deleteWhere.mockRejectedValue(new Error('Database failed'));
    await expect(reconcileExpiredSupportClaims('user-1')).rejects.toThrow('Database failed');
  });
});
