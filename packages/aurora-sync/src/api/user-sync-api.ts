import type { SyncData } from './sync-api-types';
import { auroraUserAgent, type SyncOptions, type AuroraBoardName, WEB_HOSTS } from './types';
import {
  assertAuroraResponseOk,
  createAuroraInvalidResponseError,
  createAuroraNetworkError,
  createAuroraTimeoutError,
  isAuroraRequestError,
} from './errors';

export async function userSync(
  board: AuroraBoardName,
  userId: number,
  options: SyncOptions = {},
  token: string,
): Promise<SyncData> {
  const { sharedSyncs = [], userSyncs = [] } = options;

  // Build URL-encoded form data using URLSearchParams for proper encoding
  const searchParams = new URLSearchParams();

  // Add shared sync timestamps
  sharedSyncs.forEach((sync) => {
    searchParams.append(sync.table_name, sync.last_synchronized_at);
  });

  // Add user sync timestamps
  userSyncs.forEach((sync) => {
    searchParams.append(sync.table_name, sync.last_synchronized_at);
  });

  const requestBody = searchParams.toString();

  const webUrl = `${WEB_HOSTS[board]}/sync`;
  const hostName = new URL(webUrl).hostname;

  // Match headers from AuroraClimbingClient for consistency with login request
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
