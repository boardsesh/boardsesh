/**
 * Kilter sync stream API wrapper.
 *
 * The new Kilter backend exposes a sync endpoint at sync1.kiltergrips.com/sync/stream
 * that accepts the same table-timestamp form data as the old Aurora /sync endpoint,
 * but uses Bearer token auth instead of Cookie auth.
 */

import type { KilterSyncData, KilterSyncOptions } from './types';

const KILTER_SYNC_URL = 'https://sync1.kiltergrips.com/sync/stream';

/**
 * Call the Kilter user sync stream.
 * Mirrors the interface of the old Aurora userSync function.
 */
export async function kilterUserSync(
  accessToken: string,
  options: KilterSyncOptions = {},
): Promise<KilterSyncData> {
  const { sharedSyncs = [], userSyncs = [] } = options;

  const searchParams = new URLSearchParams();

  // Add shared sync timestamps
  for (const sync of sharedSyncs) {
    searchParams.append(sync.table_name, sync.last_synchronized_at);
  }

  // Add user sync timestamps
  for (const sync of userSyncs) {
    searchParams.append(sync.table_name, sync.last_synchronized_at);
  }

  const requestBody = searchParams.toString();

  const response = await fetch(KILTER_SYNC_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: requestBody,
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Kilter sync stream failed: ${response.status} ${errorText}`);
  }

  return response.json() as Promise<KilterSyncData>;
}

/**
 * Call the Kilter shared sync stream (for global data like climbs, products, etc.)
 */
export async function kilterSharedSync(
  accessToken: string,
  options: KilterSyncOptions = {},
): Promise<KilterSyncData> {
  // Shared sync uses the same endpoint but only with sharedSyncs timestamps
  return kilterUserSync(accessToken, options);
}
