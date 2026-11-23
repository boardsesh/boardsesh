import { readOfflineWriteRelease } from './offline-write-context';
import type { GraphQLFetch } from '@boardsesh/offline-sync';
import { OFFLINE_WRITE_DELIVERY_HEADER, OFFLINE_WRITE_RELEASE_HEADER } from '@boardsesh/shared-schema';
import { getOfflineSyncHttpClient } from '../lib/graphql/client';

/** Headers belong to this request; concurrent sync reads never inherit a write identity. */
export const offlineWriteFetch: GraphQLFetch = (query, variables, options) =>
  getOfflineSyncHttpClient().request(
    query,
    variables,
    options?.offlineWriteDeliveryId
      ? {
          [OFFLINE_WRITE_DELIVERY_HEADER]: options.offlineWriteDeliveryId,
          [OFFLINE_WRITE_RELEASE_HEADER]: JSON.stringify(readOfflineWriteRelease()),
        }
      : undefined,
  );
