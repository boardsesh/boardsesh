import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureMutationQueueTable, readOfflineWriteObservations } from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import { OFFLINE_WRITE_DELIVERY_HEADER, OFFLINE_WRITE_RELEASE_HEADER } from '@boardsesh/shared-schema';

const device = vi.hoisted(() => ({ OS: 'ios', updateId: 'enqueue-ota', offline: true }));
const request = vi.hoisted(() => vi.fn().mockResolvedValue({}));
vi.mock('react-native', () => ({ Platform: device }));
vi.mock('../../lib/release-context', () => ({
  readMobileReleaseContext: () => ({
    runtimeVersion: 'native-runtime',
    updateId: device.updateId,
    isEmbeddedLaunch: false,
    branch: 'production',
  }),
}));
vi.mock('../../lib/connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ reason: device.offline ? 'device_offline' : null, device: 'online' }),
}));
vi.mock('../../lib/graphql/client', () => ({ getOfflineSyncHttpClient: () => ({ request }) }));
import { enqueueMeasuredMutation } from '../offline-write-context';
import { offlineWriteFetch } from '../offline-write-transport';
let db: TestSqliteDb;
beforeEach(async () => {
  db = createTestDatabase();
  await ensureMutationQueueTable(db);
  request.mockClear();
  device.updateId = 'enqueue-ota';
  device.offline = true;
});
afterEach(() => db.close());

describe('native offline delivery bindings', () => {
  it.each(['ios', 'android'])('captures the running %s release at durable enqueue', async (platform) => {
    device.OS = platform;
    await enqueueMeasuredMutation(db, 'boardsesh_ticks', 'create', {}, 'tick');
    const [observation] = await readOfflineWriteObservations(db);
    expect(observation).toMatchObject({
      connectivityReason: 'device_offline',
      originRelease: { platform, updateId: 'enqueue-ota' },
    });
    expect(observation!.deliveryId).toMatch(/^[0-9a-f-]{36}$/);
    expect(observation!.originRelease.applicationId).toBe('com.boardsesh.test');
    device.updateId = 'later-ota';
    await enqueueMeasuredMutation(db, 'boardsesh_ticks', 'create', {}, 'tick');
    expect(await readOfflineWriteObservations(db)).toHaveLength(1);
    expect((await readOfflineWriteObservations(db))[0]!.originRelease.updateId).toBe('enqueue-ota');
  });
  it('attaches the actual replay release per request and leaves concurrent reads untagged', async () => {
    device.updateId = 'replay-ota';
    await Promise.all([
      offlineWriteFetch('mutation Write { saveTick { uuid } }', {}, { offlineWriteDeliveryId: 'opaque-id' }),
      offlineWriteFetch('query Read { profile { id } }', {}),
    ]);
    const writeHeaders = request.mock.calls[0]![2] as Record<string, string>;
    expect(writeHeaders[OFFLINE_WRITE_DELIVERY_HEADER]).toBe('opaque-id');
    expect(JSON.parse(writeHeaders[OFFLINE_WRITE_RELEASE_HEADER]!)).toMatchObject({ updateId: 'replay-ota' });
    expect(request.mock.calls[1]![2]).toBeUndefined();
  });
});
