import { type AuroraBoardName, WEB_HOSTS } from './types';
import {
  assertAuroraResponseOk,
  createAuroraInvalidResponseError,
  createAuroraNetworkError,
  createAuroraTimeoutError,
  isAuroraRequestError,
} from './errors';

export type AuroraPin = {
  id: number;
  username: string;
  name: string | null;
  latitude: number | null;
  longitude: number | null;
};

export type AuroraPinsResponse = {
  gyms: AuroraPin[];
};

export async function fetchAuroraPins(board: AuroraBoardName): Promise<AuroraPinsResponse> {
  const requestUrl = new URL('/pins', WEB_HOSTS[board]);
  requestUrl.searchParams.set('gyms', '1');
  const url = requestUrl.toString();

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Kilter Board/202 CFNetwork/1568.100.1 Darwin/24.0.0',
      },
      signal: AbortSignal.timeout(30000),
    });

    await assertAuroraResponseOk(response, url);
    const parsed = (await response.json()) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('gyms' in parsed) ||
      !Array.isArray((parsed as { gyms: unknown }).gyms)
    ) {
      throw createAuroraInvalidResponseError(url, parsed);
    }
    return parsed as AuroraPinsResponse;
  } catch (error) {
    if (isAuroraRequestError(error)) {
      throw error;
    }
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw createAuroraTimeoutError(url, error);
    }
    if (error instanceof TypeError) {
      throw createAuroraNetworkError(url, error);
    }
    throw createAuroraInvalidResponseError(url, error);
  }
}
