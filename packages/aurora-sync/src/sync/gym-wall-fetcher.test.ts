import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  signIn: vi.fn(),
  fetchAuroraGymUser: vi.fn(),
}));

vi.mock('../api/aurora-client', () => ({
  default: class {
    signIn = mocks.signIn;
  },
  AuroraClimbingClient: class {
    signIn = mocks.signIn;
  },
}));

vi.mock('../api/gym-walls-api', () => ({
  fetchAuroraGymUser: mocks.fetchAuroraGymUser,
}));

import {
  auroraLocationCredentials,
  createAuroraGymUserFetcher,
  createAuroraGymUserFetcherForToken,
} from './gym-wall-fetcher';
import { AuroraRequestError } from '../api/errors';

const PIN = { id: 42, username: 'board-house', name: 'Board House', latitude: -33.8, longitude: 151.2 };
const CREDS = {
  AURORA_LOCATION_USERNAME_TENSION: 'crawler',
  AURORA_LOCATION_PASSWORD_TENSION: 'secret',
};
const NO_CREDS = {};
const HALF_CREDS = { AURORA_LOCATION_USERNAME_TENSION: 'crawler' };

beforeEach(() => {
  vi.useFakeTimers();
  mocks.signIn.mockReset().mockResolvedValue({ token: 'session-token' });
  mocks.fetchAuroraGymUser.mockReset().mockResolvedValue({ id: 42, walls: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Drive the pacing timers so a sequential crawl completes under fake timers. */
async function drain<T>(work: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return work;
}

describe('auroraLocationCredentials', () => {
  it('reads the per-board env pair', () => {
    expect(auroraLocationCredentials('tension', CREDS)).toEqual({
      username: 'crawler',
      password: 'secret',
    });
  });

  it('returns undefined when either half is missing', () => {
    // This is the gate for the whole no-credentials fallback: dev and CI must
    // keep the pre-enrichment behaviour rather than crawl unauthenticated.
    expect(auroraLocationCredentials('tension', NO_CREDS)).toBeUndefined();
    expect(auroraLocationCredentials('tension', HALF_CREDS)).toBeUndefined();
  });

  it('is scoped per board app', () => {
    // Aurora accounts don't span board apps, so Tension credentials must not
    // silently authorise a Decoy crawl.
    expect(auroraLocationCredentials('decoy', CREDS)).toBeUndefined();
  });
});

describe('createAuroraGymUserFetcher', () => {
  it('returns undefined without credentials, and never logs in', async () => {
    const fetcher = await createAuroraGymUserFetcher({ board: 'tension', env: NO_CREDS });

    expect(fetcher).toBeUndefined();
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it('returns undefined when the login fails rather than failing the sync', async () => {
    // A bad password must degrade to guessed configs, not remove every gym from
    // the map.
    mocks.signIn.mockRejectedValue(new Error('invalid credentials'));

    const fetcher = await createAuroraGymUserFetcher({ board: 'tension', env: CREDS });

    expect(fetcher).toBeUndefined();
  });

  it('treats a login with no token as a failed login', async () => {
    mocks.signIn.mockResolvedValue({ token: undefined });

    expect(await createAuroraGymUserFetcher({ board: 'tension', env: CREDS })).toBeUndefined();
  });

  it('passes the session token through to each gym lookup', async () => {
    const fetcher = await createAuroraGymUserFetcher({ board: 'tension', env: CREDS });

    await drain(fetcher!(PIN));

    expect(mocks.fetchAuroraGymUser).toHaveBeenCalledWith('tension', 42, 'session-token');
  });

  it('paces successive gyms so the crawl stays under Aurora rate limits', async () => {
    const fetcher = await createAuroraGymUserFetcher({ board: 'tension', env: CREDS });

    await drain(fetcher!(PIN));
    expect(mocks.fetchAuroraGymUser).toHaveBeenCalledTimes(1);

    // The second call must wait out the interval. Without advancing timers it
    // stays pending — which is the pacing working.
    const second = fetcher!({ ...PIN, id: 43 });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.fetchAuroraGymUser).toHaveBeenCalledTimes(1);

    await drain(second);
    expect(mocks.fetchAuroraGymUser).toHaveBeenCalledTimes(2);
  });

  it('retries a transient failure and returns the eventual result', async () => {
    mocks.fetchAuroraGymUser
      .mockRejectedValueOnce(new AuroraRequestError({ code: 'rate_limited', message: 'slow down' }))
      .mockResolvedValueOnce({ id: 42, walls: [] });

    const fetcher = await createAuroraGymUserFetcher({ board: 'tension', env: CREDS });
    const result = await drain(fetcher!(PIN));

    expect(mocks.fetchAuroraGymUser).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ id: 42, walls: [] });
  });

  it('gives up after the attempt cap instead of retrying forever', async () => {
    mocks.fetchAuroraGymUser.mockRejectedValue(new AuroraRequestError({ code: 'rate_limited', message: 'slow down' }));

    const fetcher = await createAuroraGymUserFetcher({ board: 'tension', env: CREDS });

    // undefined, not a throw: the gym falls back to the default config and the
    // crawl carries on to the next few thousand.
    await expect(drain(fetcher!(PIN))).resolves.toBeUndefined();
    expect(mocks.fetchAuroraGymUser).toHaveBeenCalledTimes(3);
  });

  it('signs in again and retries when the session expires mid-crawl', async () => {
    // A full crawl runs for hours, so this is expected, not exotic. Aurora
    // reports a rejected session as 422 -> invalid_credentials.
    mocks.fetchAuroraGymUser
      .mockRejectedValueOnce(new AuroraRequestError({ code: 'invalid_credentials', message: 'rejected' }))
      .mockResolvedValueOnce({ id: 42, walls: [] });
    mocks.signIn.mockResolvedValueOnce({ token: 'first' }).mockResolvedValueOnce({ token: 'second' });

    const fetcher = await createAuroraGymUserFetcher({ board: 'tension', env: CREDS });
    const result = await drain(fetcher!(PIN));

    expect(mocks.signIn).toHaveBeenCalledTimes(2);
    expect(mocks.fetchAuroraGymUser).toHaveBeenLastCalledWith('tension', 42, 'second');
    expect(result).toEqual({ id: 42, walls: [] });
  });

  it('uses the refreshed session even when expiry lands on the final attempt', async () => {
    // The refresh used to `continue` straight past the loop condition, so a new
    // session bought on the last pass was thrown away unused and the gym fell
    // back to the guess with nothing in the log to say why.
    mocks.fetchAuroraGymUser
      .mockRejectedValueOnce(new AuroraRequestError({ code: 'rate_limited', message: 'slow' }))
      .mockRejectedValueOnce(new AuroraRequestError({ code: 'rate_limited', message: 'slow' }))
      .mockRejectedValueOnce(new AuroraRequestError({ code: 'invalid_credentials', message: 'expired' }))
      .mockResolvedValueOnce({ id: 42, walls: [] });
    mocks.signIn.mockResolvedValueOnce({ token: 'first' }).mockResolvedValueOnce({ token: 'second' });

    const fetcher = await createAuroraGymUserFetcher({ board: 'tension', env: CREDS });

    expect(await drain(fetcher!(PIN))).toEqual({ id: 42, walls: [] });
    expect(mocks.fetchAuroraGymUser).toHaveBeenCalledTimes(4);
  });

  it('re-authenticates at most once per gym so bad credentials cannot spin', async () => {
    mocks.fetchAuroraGymUser.mockRejectedValue(
      new AuroraRequestError({ code: 'invalid_credentials', message: 'rejected' }),
    );

    const fetcher = await createAuroraGymUserFetcher({ board: 'tension', env: CREDS });

    await expect(drain(fetcher!(PIN))).resolves.toBeUndefined();
    // One initial login + one refresh; two lookups, then it gives up on the gym.
    expect(mocks.signIn).toHaveBeenCalledTimes(2);
    expect(mocks.fetchAuroraGymUser).toHaveBeenCalledTimes(2);
  });

  it('falls back to default configs when the re-login itself fails', async () => {
    mocks.fetchAuroraGymUser.mockRejectedValue(
      new AuroraRequestError({ code: 'invalid_credentials', message: 'rejected' }),
    );
    mocks.signIn.mockResolvedValueOnce({ token: 'first' }).mockRejectedValueOnce(new Error('nope'));

    const fetcher = await createAuroraGymUserFetcher({ board: 'tension', env: CREDS });

    await expect(drain(fetcher!(PIN))).resolves.toBeUndefined();
    expect(mocks.fetchAuroraGymUser).toHaveBeenCalledTimes(1);
  });

  it('stops spending requests once the session is unrecoverable', async () => {
    // Without the latch, every remaining gym in a multi-thousand crawl paid for
    // a doomed lookup AND a doomed re-auth — double the requests for a run that
    // can no longer succeed.
    mocks.fetchAuroraGymUser.mockRejectedValue(
      new AuroraRequestError({ code: 'invalid_credentials', message: 'rejected' }),
    );
    mocks.signIn.mockResolvedValueOnce({ token: 'first' }).mockRejectedValue(new Error('nope'));

    const fetcher = await createAuroraGymUserFetcher({ board: 'tension', env: CREDS });

    await expect(drain(fetcher!(PIN))).resolves.toBeUndefined();
    const lookupsAfterFirstGym = mocks.fetchAuroraGymUser.mock.calls.length;
    const loginsAfterFirstGym = mocks.signIn.mock.calls.length;

    // Three more gyms cost nothing at all.
    for (const id of [43, 44, 45]) {
      await expect(drain(fetcher!({ ...PIN, id }))).resolves.toBeUndefined();
    }

    expect(mocks.fetchAuroraGymUser).toHaveBeenCalledTimes(lookupsAfterFirstGym);
    expect(mocks.signIn).toHaveBeenCalledTimes(loginsAfterFirstGym);
  });

  it('keeps crawling after one gym fails', async () => {
    mocks.fetchAuroraGymUser
      .mockRejectedValueOnce(new AuroraRequestError({ code: 'rate_limited', message: 'slow down' }))
      .mockRejectedValueOnce(new AuroraRequestError({ code: 'rate_limited', message: 'slow down' }))
      .mockRejectedValueOnce(new AuroraRequestError({ code: 'rate_limited', message: 'slow down' }))
      .mockResolvedValueOnce({ id: 43, walls: [] });

    const fetcher = await createAuroraGymUserFetcher({ board: 'tension', env: CREDS });

    expect(await drain(fetcher!(PIN))).toBeUndefined();
    expect(await drain(fetcher!({ ...PIN, id: 43 }))).toEqual({ id: 43, walls: [] });
  });
});

/**
 * The daemon crawls with the same borrowed credential the shared sync is already
 * running on, so it must not open a session of its own — a second login per
 * cycle would double the auth load on a real climber's account for nothing.
 */
describe('createAuroraGymUserFetcherForToken', () => {
  it('uses the supplied token and never logs in', async () => {
    const fetcher = createAuroraGymUserFetcherForToken({ board: 'tension', token: 'borrowed' });

    await drain(fetcher(PIN));

    expect(mocks.signIn).not.toHaveBeenCalled();
    expect(mocks.fetchAuroraGymUser).toHaveBeenCalledWith('tension', 42, 'borrowed');
  });

  it('ends the slice on an expired token rather than re-authenticating', async () => {
    // There is nothing to re-auth WITH — the token belongs to the shared sync's
    // credential rotation, and the next cycle brings a fresh one.
    mocks.fetchAuroraGymUser.mockRejectedValue(
      new AuroraRequestError({ code: 'invalid_credentials', message: 'rejected' }),
    );
    const fetcher = createAuroraGymUserFetcherForToken({ board: 'tension', token: 'borrowed' });

    await expect(drain(fetcher(PIN))).resolves.toBeUndefined();
    expect(mocks.signIn).not.toHaveBeenCalled();
    expect(mocks.fetchAuroraGymUser).toHaveBeenCalledTimes(1);
  });

  it('still paces and retries transient failures', async () => {
    mocks.fetchAuroraGymUser
      .mockRejectedValueOnce(new AuroraRequestError({ code: 'rate_limited', message: 'slow down' }))
      .mockResolvedValueOnce({ id: 42, walls: [] });
    const fetcher = createAuroraGymUserFetcherForToken({ board: 'tension', token: 'borrowed' });

    expect(await drain(fetcher(PIN))).toEqual({ id: 42, walls: [] });
    expect(mocks.fetchAuroraGymUser).toHaveBeenCalledTimes(2);
  });
});
