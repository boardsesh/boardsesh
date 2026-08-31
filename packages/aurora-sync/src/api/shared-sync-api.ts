import type { SyncData } from './sync-api-types';
import { auroraUserAgent, type SyncOptions, type AuroraBoardName, WEB_HOSTS, SHARED_SYNC_TABLES } from './types';
import {
  assertAuroraResponseOk,
  createAuroraInvalidResponseError,
  createAuroraNetworkError,
  createAuroraTimeoutError,
  isAuroraRequestError,
} from './errors';

export async function sharedSync(
  board: AuroraBoardName,
  options: Omit<SyncOptions, 'walls' | 'wallExpungements'> = {},
  token: string,
): Promise<SyncData> {
  const { sharedSyncs = [] } = options;

  // Build URL-encoded form data using URLSearchParams for proper encoding
  // Add shared sync timestamps - matching Android app's table order
  const orderedTables = SHARED_SYNC_TABLES;

  // Create a map for quick lookup
  const syncMap = new Map(sharedSyncs.map((s) => [s.table_name, s.last_synchronized_at]));

  // Add parameters in the same order as Android app
  const searchParams = new URLSearchParams();
  orderedTables.forEach((tableName) => {
    const timestamp = syncMap.get(tableName) || '1970-01-01 00:00:00.000000';
    searchParams.append(tableName, timestamp);
  });

  const requestBody = searchParams.toString();

  const webUrl = `${WEB_HOSTS[board]}/sync`;
  const hostName = new URL(webUrl).hostname;

  // Match headers from AuroraClimbingClient for consistency
  const headers = {
    Host: hostName,
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
    Connection: 'keep-alive',
    'Accept-Language': 'en-AU,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'User-Agent': auroraUserAgent(board),
    Cookie: `token=${token}`,
  };

  try {
    const response = await fetch(webUrl, {
      method: 'POST',
      headers,
      body: requestBody,
      signal: AbortSignal.timeout(30000),
    });

    await assertAuroraResponseOk(response, webUrl);
    return await response.json();
  } catch (error) {
    if (isAuroraRequestError(error)) {
      throw error;
    }

    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw createAuroraTimeoutError(webUrl, error);
    }

    if (error instanceof TypeError) {
      throw createAuroraNetworkError(webUrl, error);
    }

    throw createAuroraInvalidResponseError(webUrl, error);
  }
}
