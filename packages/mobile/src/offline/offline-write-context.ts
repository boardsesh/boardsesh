import { Platform } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { applicationId, nativeApplicationVersion } from 'expo-application';
import { enqueue, markOfflineWritesSuperseded, type SqlExecutor, type SqlValue } from '@boardsesh/offline-sync';
import type { OfflineWriteRelease } from '@boardsesh/shared-schema';
import { getConnectivitySnapshot } from '../lib/connectivity/connectivity-store';
import { readMobileReleaseContext } from '../lib/release-context';

export function readOfflineWriteRelease(): OfflineWriteRelease {
  const release = readMobileReleaseContext();
  return {
    platform: Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'unknown',
    applicationId: applicationId ?? null,
    appVersion: nativeApplicationVersion ?? null,
    runtimeVersion: release.runtimeVersion,
    updateId: release.updateId,
    isEmbedded: release.isEmbeddedLaunch,
    branch: release.branch,
  };
}

/** The same INSERT commits the write and its denominator; retries reuse its identity. */
export const enqueueMeasuredMutation: typeof enqueue = (db, tableName, operation, payload, key, options) => {
  const connectivity = getConnectivitySnapshot();
  return enqueue(db, tableName, operation, payload, key, {
    ...options,
    delivery: {
      deliveryId: randomUUID(),
      queuedAt: new Date().toISOString(),
      connectivityReason: connectivity.reason ?? (connectivity.device === 'unknown' ? 'unknown' : 'online'),
      originRelease: readOfflineWriteRelease(),
    },
  });
};

/** Preserve cancellation evidence before the existing outbox DELETE commits. */
export async function cancelMeasuredMutations(
  db: SqlExecutor,
  deleteSql: string,
  parameters: SqlValue[],
): Promise<void> {
  const mutations = await db.getAllAsync<{ idempotency_key: string }>(
    deleteSql.replace('DELETE FROM pending_mutations', 'SELECT idempotency_key FROM pending_mutations'),
    parameters,
  );
  await markOfflineWritesSuperseded(
    db,
    mutations.map((mutation) => mutation.idempotency_key),
  );
  await db.runAsync(deleteSql, parameters);
}
