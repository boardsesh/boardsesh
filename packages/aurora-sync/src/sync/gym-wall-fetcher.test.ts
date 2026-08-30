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

import { auroraLocationCredentials, createAuroraGymUserFetcher } from './gym-wall-fetcher';
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
