import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  applyRateLimit: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('../db/client', () => ({
  db: { transaction: mocks.transaction },
}));

vi.mock('../graphql/resolvers/social/roles', () => ({
  requireAdmin: mocks.requireAdmin,
}));

vi.mock('../graphql/resolvers/shared/helpers', async (importOriginal) => {
  const original = await importOriginal<typeof import('../graphql/resolvers/shared/helpers')>();
  return { ...original, applyRateLimit: mocks.applyRateLimit };
});

import { socialLocationSyncFreezeMutations } from '../graphql/resolvers/social/location-sync-freezes';

describe('clearLocationSyncFreeze actor validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue(undefined);
    mocks.applyRateLimit.mockResolvedValue(undefined);
  });

  it('rejects a malformed authenticated context without an audit actor after admin authorization', async () => {
    const ctx = {
      connectionId: 'conn-missing-user-id',
      isAuthenticated: true,
    } as ConnectionContext;

    await expect(
      socialLocationSyncFreezeMutations.clearLocationSyncFreeze(
        null,
        {
          input: {
            entityType: 'GYM',
            entityUuid: '00000000-0000-0000-0000-000000000000',
            expectedSyncFrozenAt: '2026-08-01T01:02:03.000Z',
            reason: 'This context has no user to record in the audit trail.',
          },
        },
        ctx,
      ),
    ).rejects.toThrow('Authentication required to perform this operation');

    expect(mocks.requireAdmin).toHaveBeenCalledWith(ctx);
    expect(mocks.applyRateLimit).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
