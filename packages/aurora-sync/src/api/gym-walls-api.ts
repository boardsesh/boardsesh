import { type AuroraBoardName, WEB_HOSTS } from './types';
import type { Wall } from './sync-api-types';
import {
  assertAuroraResponseOk,
  createAuroraInvalidResponseError,
  createAuroraNetworkError,
  createAuroraTimeoutError,
  isAuroraRequestError,
} from './errors';

/**
 * The gym half of an Aurora user record: the address and coordinates the gym
 * itself published. `/pins?gyms=1` only carries a name and a rough lat/lng, so
 * this is where a real street address comes from.
 */
export type AuroraGymProfile = {
  user_id: number;
  address1?: string | null;
  city?: string | null;
  country?: string | null;
  postal_code?: string | null;
  homepage_url?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

export type AuroraGymUser = {
  id: number;
  username?: string | null;
  /**
   * Every wall this gym has registered, with its REAL configuration: layout,
   * product size, hold sets, angle, adjustability and controller serial. This
   * is the data the location sync used to guess at — Tension gyms were all
   * hardcoded to layout 10 ("Tension Board 2 Mirror") whether or not the wall
   * was actually a Spray.
   */
  walls?: Wall[];
  gym?: AuroraGymProfile | null;
};

type AuroraUsersResponse = {
  users: AuroraGymUser[];
};

/**
 * Fetch one Aurora user (a gym is a user account) with its walls and gym
 * profile.
 *
 * `GET https://{board}.com/users/{id}` with a session cookie. Requires auth:
 * unauthenticated callers get nothing useful back, which is why the location
 * sync has to sign in before enriching pins.
 *
 * Returns `undefined` for 404 — a pin can outlive the account it points at, and
 * one dead gym must not abort a crawl of several thousand. Every other failure
 * throws an `AuroraRequestError` so the caller can tell a rate limit
 * (retryable) from a malformed response (not).
 */
export async function fetchAuroraGymUser(
  board: AuroraBoardName,
  gymUserId: number,
  token: string,
): Promise<AuroraGymUser | undefined> {
  const url = new URL(`/users/${gymUserId}`, WEB_HOSTS[board]).toString();

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Cookie: `token=${token}`,
        'User-Agent': 'Kilter Board/202 CFNetwork/1568.100.1 Darwin/24.0.0',
      },
      signal: AbortSignal.timeout(30000),
    });

    if (response.status === 404) return undefined;

    await assertAuroraResponseOk(response, url);
    const parsed = (await response.json()) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('users' in parsed) ||
      !Array.isArray((parsed as { users: unknown }).users)
    ) {
      throw createAuroraInvalidResponseError(url, parsed);
    }
    // Aurora answers a single-id lookup with a one-element array. An empty array
    // is the same fact as a 404 (no such user), not a malformed response.
    const user = (parsed as AuroraUsersResponse).users[0];
    if (user === undefined) return undefined;

    // Validate the nested shape HERE rather than trusting the cast. A malformed
    // `walls` (an object, a string, an array of junk) would otherwise sail past
    // this boundary and blow up later inside the record builder — aborting the
    // whole board's sync partway through a multi-hour crawl instead of failing
    // just this one gym. As an `invalid_response` it is transient, so the gym is
    // retried and everything else carries on.
    if (typeof user !== 'object' || user === null) {
      throw createAuroraInvalidResponseError(url, parsed);
    }
    if (user.walls !== undefined && user.walls !== null) {
      if (!Array.isArray(user.walls) || user.walls.some((wall) => typeof wall !== 'object' || wall === null)) {
        throw createAuroraInvalidResponseError(url, parsed);
      }
    }
    return user;
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
