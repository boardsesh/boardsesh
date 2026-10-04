import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const { claims, mockDb, retrieve, list, lockSupportAccount, deleteWhere, claimLimit, logger } = vi.hoisted(() => ({
  claims: [] as Array<{
    id: string;
    checkoutSessionId: string | null;
    createdAt: Date;
    checkoutExpiresAt: Date | null;
  }>,
  mockDb: { transaction: vi.fn(), select: vi.fn(), delete: vi.fn() },
  retrieve: vi.fn(),
  list: vi.fn(),
  lockSupportAccount: vi.fn(),
  deleteWhere: vi.fn(),
  claimLimit: vi.fn(),
  logger: { warn: vi.fn() },
}));
vi.mock('../db/client', () => ({ db: mockDb }));
vi.mock('../utils/logger', () => ({ logger }));
vi.mock('./stripe-support-lock', () => ({ lockSupportAccount }));
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
  lockSupportAccount.mockResolvedValue({ id: 'user-1' });
  mockDb.transaction.mockImplementation(async (callback: (transaction: typeof mockDb) => Promise<void>) =>
    callback(mockDb),
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
  it('releases an abandoned fixed-expiry claim only after exhausting the bounded Stripe scan', async () => {
    list
      .mockResolvedValueOnce({
        data: [{ id: 'cs_other', client_reference_id: 'other', status: 'complete' }],
        has_more: true,
      })
      .mockResolvedValueOnce({ data: [], has_more: false });
    await reconcileExpiredSupportClaims('user-1');
    expect(lockSupportAccount).toHaveBeenCalledWith(mockDb, 'user-1');
    expect(claimLimit).toHaveBeenCalledWith(10);
    expect(list).toHaveBeenNthCalledWith(1, {
      limit: 100,
      created: { gte: Date.parse('2026-09-30T23:59:00Z') / 1000, lte: Date.parse('2026-10-02T00:00:00Z') / 1000 },
    });
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
    expect(retrieve).toHaveBeenCalledWith('cs_1');
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
