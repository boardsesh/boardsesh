import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enqueue,
  ensureMutationQueueTable,
  peekPending,
  readOfflineWriteObservations,
  runMigrations,
  stampLocalUserId,
  type GraphQLFetch,
} from '@boardsesh/offline-sync';
import { createTestDatabase, __resetDrainerStateForTests, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import type { OfflineWriteObservation, OfflineWriteRelease } from '@boardsesh/shared-schema';
import { publishOfflineWriteDelivery, type OfflineWritePublicationOptions } from '../offline-write-delivery';
import { hasOfflineWriteLocalProof } from '../offline-write-local-proof';

const release: OfflineWriteRelease = {
  platform: 'ios',
  applicationId: 'com.boardsesh.app',
  appVersion: '2.8.0',
  runtimeVersion: 'runtime',
  updateId: 'ota',
  isEmbedded: false,
  branch: 'production',
};
let db: TestSqliteDb;
let current: boolean;
let options: OfflineWritePublicationOptions;
beforeEach(async () => {
  __resetDrainerStateForTests();
  db = createTestDatabase();
  await ensureMutationQueueTable(db);
  await runMigrations(db);
  await stampLocalUserId(db, 'owner');
  current = true;
  options = {
    ownerUserId: 'owner',
    isCurrent: () => current,
    observedRelease: release,
    verifyLocalState: (candidate) => hasOfflineWriteLocalProof(db, candidate, 'owner'),
  };
});
afterEach(() => {
  db.close();
  __resetDrainerStateForTests();
});
async function queue(id = 'delivery-1') {
  await enqueue(
    db,
    'boardsesh_ticks',
    'create',
    { boardType: 'kilter', climbUuid: 'private-climb', comment: 'private-comment' },
    'private-tick',
    {
      delivery: {
        deliveryId: id,
        queuedAt: new Date().toISOString(),
        connectivityReason: 'device_offline',
        originRelease: release,
      },
    },
  );
}
function publish(fetch: unknown, publicationOptions = options) {
  return publishOfflineWriteDelivery(db, fetch as GraphQLFetch, publicationOptions);
}

function acceptingFetch() {
  return vi.fn<GraphQLFetch>(async (_query, variables) => {
    const observations = (variables!.input as { observations: OfflineWriteObservation[] }).observations;
    return {
      recordOfflineWriteObservations: {
        receipts: observations.map((observation) => ({
          deliveryId: observation.deliveryId,
          revision: observation.revision,
          serverAcceptedAt: null,
          serverRejectedAt: null,
        })),
      },
    } as never;
  });
}

describe('private offline delivery publication', () => {
  it('preserves a failed upload for retry, without leaking private targets or payload', async () => {
    await queue();
    await publish(vi.fn<GraphQLFetch>().mockRejectedValue(new Error('network down')), options);
    expect(await readOfflineWriteObservations(db)).toHaveLength(1);
    const fetch = acceptingFetch();
    await publish(fetch, options);
    expect(await readOfflineWriteObservations(db)).toEqual([]);
    const serialized = JSON.stringify(fetch.mock.calls);
    expect(serialized).toContain('delivery-1');
    expect(serialized).not.toMatch(/private-tick|private-climb|private-comment/);
  });
  it('does not publish a different account journal or acknowledge an in-flight response after account change', async () => {
    await queue();
    const fetch = acceptingFetch();
    await publish(fetch, { ...options, ownerUserId: 'other' });
    expect(fetch).not.toHaveBeenCalled();
    let started = false;
    let respond: (result: unknown) => void = () => {};
    const held = vi.fn<GraphQLFetch>(
      async () =>
        new Promise<never>((resolve) => {
          started = true;
          respond = (result) => resolve(result as never);
        }),
    );
    const publication = publish(held, options);
    await vi.waitFor(() => expect(started).toBe(true));
    current = false;
    respond({ recordOfflineWriteObservations: { receipts: [{ deliveryId: 'delivery-1', revision: 2 }] } });
    await publication;
    expect(await readOfflineWriteObservations(db)).toHaveLength(1);
  });
  it('keeps outbox-only ticks unreconciled until an owned persisted logbook row arrives', async () => {
    await queue();
    await db.runAsync('DELETE FROM pending_mutations WHERE id = ?', [(await peekPending(db))[0]!.id]);
    await publish(acceptingFetch(), options);
    expect(await db.getFirstAsync<{ state: string }>('SELECT state FROM offline_write_delivery_journal')).toEqual({
      state: 'finalized',
    });
    await db.runAsync('INSERT INTO boardsesh_ticks (uuid, user_id) VALUES (?, ?)', ['private-tick', 'owner']);
    const fetch = acceptingFetch();
    await publish(fetch, options);
    const observation = (fetch.mock.calls[0]![1]!.input as { observations: OfflineWriteObservation[] })
      .observations[0]!;
    expect(observation).toMatchObject({ state: 'reconciled', deliveryId: 'delivery-1' });
    expect(observation.reconciledAt).not.toBeNull();
  });
  it('reports the denominator even when local reconciliation throws', async () => {
    await queue();
    await db.runAsync('DELETE FROM pending_mutations WHERE id = ?', [(await peekPending(db))[0]!.id]);
    const fetch = acceptingFetch();
    await publish(fetch, {
      ...options,
      verifyLocalState: async () => {
        throw new Error('local lock');
      },
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect((fetch.mock.calls[0]![1]!.input as { observations: OfflineWriteObservation[] }).observations[0]!.state).toBe(
      'finalized',
    );
  });
  it('does not acknowledge an empty response or a receipt for a newer unsent revision', async () => {
    await queue();
    await publish(vi.fn<GraphQLFetch>().mockResolvedValue({}), options);
    expect(await readOfflineWriteObservations(db)).toHaveLength(1);
    await publish(
      vi.fn<GraphQLFetch>().mockResolvedValue({
        recordOfflineWriteObservations: { receipts: [{ deliveryId: 'delivery-1', revision: 999 }] },
      }),
      options,
    );
    expect(await readOfflineWriteObservations(db)).toHaveLength(1);
  });
});
