import { describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';

vi.mock('../graphql/resolvers/shared/helpers', () => ({
  requireAuthenticated(context: ConnectionContext) {
    if (!context.isAuthenticated || !context.userId)
      throw new GraphQLError('Sign in', { extensions: { code: 'UNAUTHENTICATED' } });
  },
  applyRateLimit: vi.fn().mockResolvedValue(undefined),
  validateInput: (schema: { parse(input: unknown): unknown }, input: unknown) => schema.parse(input),
}));
vi.mock('../services/offline-write-delivery', () => ({
  recordOfflineWriteObservation: vi.fn().mockResolvedValue(null),
}));

import { offlineWriteDeliveryMutations } from '../graphql/resolvers/sync/offline-write-delivery';
import { recordOfflineWriteObservation } from '../services/offline-write-delivery';

const input = (ownerUserId: string) => ({
  ownerUserId,
  observations: [
    {
      deliveryId: '50000000-0000-4000-8000-000000000001',
      tableName: 'boardsesh_ticks',
      operation: 'create',
      queuedAt: '2026-11-20T12:00:00.000Z',
      connectivityReason: 'device_offline',
      originRelease: {
        applicationId: 'com.boardsesh.app',
        platform: 'ios',
        appVersion: null,
        runtimeVersion: null,
        updateId: null,
        isEmbedded: null,
        branch: null,
      },
      state: 'pending',
      observedAt: '2026-11-21T12:00:00.000Z',
      revision: 1,
      recovered: false,
    },
  ],
});

describe('receipt upload account fencing', () => {
  it('rejects an upload whose captured owner differs from the current bearer', async () => {
    vi.mocked(recordOfflineWriteObservation).mockClear();
    await expect(
      offlineWriteDeliveryMutations.recordOfflineWriteObservations(
        undefined,
        { input: input('previous-owner') },
        {
          connectionId: 'test',
          userId: 'next-owner',
          isAuthenticated: true,
        },
      ),
    ).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(recordOfflineWriteObservation).not.toHaveBeenCalled();
  });

  it('uses the authenticated owner for every accepted observation', async () => {
    vi.mocked(recordOfflineWriteObservation).mockClear();
    await offlineWriteDeliveryMutations.recordOfflineWriteObservations(
      undefined,
      { input: input('owner') },
      {
        connectionId: 'test',
        userId: 'owner',
        isAuthenticated: true,
      },
    );
    expect(recordOfflineWriteObservation).toHaveBeenCalledWith(
      'owner',
      expect.objectContaining({ tableName: 'boardsesh_ticks' }),
    );
  });

  it('rejects anonymous submissions before receipt storage', async () => {
    vi.mocked(recordOfflineWriteObservation).mockClear();
    await expect(
      offlineWriteDeliveryMutations.recordOfflineWriteObservations(
        undefined,
        { input: input('owner') },
        {
          connectionId: 'test',
          isAuthenticated: false,
        },
      ),
    ).rejects.toMatchObject({ extensions: { code: 'UNAUTHENTICATED' } });
    expect(recordOfflineWriteObservation).not.toHaveBeenCalled();
  });
});
