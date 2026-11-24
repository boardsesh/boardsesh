import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { lookupAddressCoordinates, resolveGymAddressLocation } from '../services/gym-address-location';

const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), eval: vi.fn(), clients: vi.fn(), fetch: vi.fn() }));
vi.mock('../redis/client', () => ({ redisClientManager: { getClients: mocks.clients } }));
const gym = {
  address: 'Damrak 1, Amsterdam, Netherlands',
  latitude: null,
  longitude: null,
  reportingTimeZone: null,
  isPublic: true,
  isListed: true,
};
const coordinates = { latitude: 52.37, longitude: 4.89 };

beforeEach(() => {
  vi.unstubAllEnvs();
  mocks.get.mockReset().mockResolvedValue(null);
  mocks.set.mockReset().mockResolvedValue('OK');
  mocks.eval.mockReset().mockResolvedValue(1);
  mocks.clients.mockReset().mockReturnValue({ publisher: mocks });
  mocks.fetch.mockReset().mockResolvedValue({ ok: true, json: async () => [{ lat: '52.37', lon: '4.89' }] });
  vi.stubGlobal('fetch', mocks.fetch);
});

describe('gym address location', () => {
  it.each([
    { isPublic: false },
    { isListed: false },
    { reportingTimeZone: 'UTC' },
    { latitude: 52.37, longitude: 4.89 },
    { address: null },
    { address: 'a' },
  ])('does not send private, configured or mapped gyms to a provider (%j)', async (changes) => {
    expect(await resolveGymAddressLocation({ ...gym, ...changes })).toBeNull();
    expect(mocks.clients).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('binds a unique valid result to the exact stored address', async () => {
    expect(await resolveGymAddressLocation(gym)).toEqual({ address: gym.address, ...coordinates });
    const [url, options] = mocks.fetch.mock.calls[0];
    expect(url.origin).toBe('https://nominatim.openstreetmap.org');
    expect(url.searchParams.get('q')).toBe(gym.address);
    expect(url.searchParams.get('limit')).toBe('2');
    expect(options.headers['User-Agent']).toContain('Boardsesh');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(mocks.set.mock.calls.at(-1)).toEqual([
      expect.stringMatching(/^gym-address-location:v1:[a-f0-9]{64}$/),
      JSON.stringify(coordinates),
      'EX',
      2_592_000,
      'NX',
    ]);
    expect(mocks.set.mock.calls[0][0]).not.toContain('Amsterdam');
  });

  it.each([JSON.stringify(coordinates), 'null'])(
    'uses shared cached evidence without a request (%s)',
    async (cached) => {
      mocks.get.mockResolvedValue(cached);
      expect(await lookupAddressCoordinates(gym.address)).toEqual(JSON.parse(cached));
      expect(mocks.set).not.toHaveBeenCalled();
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );

  it('does not request or poison the cache when the global budget is held', async () => {
    mocks.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    expect(await lookupAddressCoordinates(gym.address)).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.set).toHaveBeenCalledTimes(2);
    const [addressLeaseKey, addressLeaseOwner] = mocks.set.mock.calls[0];
    expect(mocks.eval).toHaveBeenCalledWith(expect.any(String), 1, addressLeaseKey, addressLeaseOwner);
  });

  it('lets the same address retry as soon as the shared request budget becomes available', async () => {
    const budgetKey = 'gym-address-location:request-budget';
    const cache = new Map<string, string>([[budgetKey, 'another-address']]);
    mocks.get.mockImplementation(async (key: string) => cache.get(key) ?? null);
    mocks.set.mockImplementation(async (key: string, contents: string, ...options: (string | number)[]) => {
      if (options.includes('NX') && cache.has(key)) return null;
      cache.set(key, contents);
      return 'OK';
    });
    mocks.eval.mockImplementation(async (_script: string, _keys: number, key: string, owner: string) => {
      if (cache.get(key) !== owner) return 0;
      cache.delete(key);
      return 1;
    });

    expect(await lookupAddressCoordinates(gym.address)).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
    const addressLeaseKey = String(mocks.set.mock.calls[0][0]);
    expect(cache.has(addressLeaseKey)).toBe(false);

    cache.delete(budgetKey);
    expect(await lookupAddressCoordinates(gym.address)).toEqual(coordinates);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('releases only its own address lease using the actual Redis comparison script', async () => {
    mocks.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    await lookupAddressCoordinates(gym.address);
    const [releaseScript, , , previousOwner] = mocks.eval.mock.calls[0] as [string, number, string, string];
    const publisher = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6380');
    const leaseKey = 'gym-address-lease-test:' + randomUUID();
    const successorOwner = randomUUID();
    try {
      await publisher.set(leaseKey, successorOwner, 'PX', 15_000);
      expect(await publisher.eval(releaseScript, 1, leaseKey, previousOwner)).toBe(0);
      expect(await publisher.get(leaseKey)).toBe(successorOwner);
      expect(await publisher.eval(releaseScript, 1, leaseKey, successorOwner)).toBe(1);
      expect(await publisher.get(leaseKey)).toBeNull();
    } finally {
      await publisher.del(leaseKey);
      await publisher.quit();
    }
  });

  it('holds an address lease longer than the HTTP deadline', async () => {
    mocks.set.mockResolvedValueOnce(null);
    expect(await lookupAddressCoordinates(gym.address)).toBeNull();
    expect(mocks.set).toHaveBeenCalledWith(
      expect.stringContaining(':in-flight'),
      expect.any(String),
      'PX',
      15_000,
      'NX',
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { response: [] },
    {
      response: [
        { lat: '52.37', lon: '4.89' },
        { lat: '40.71', lon: '-74.0' },
      ],
    },
    { response: [{ lat: '', lon: '4.89' }] },
    { response: [{ lat: '999', lon: '4.89' }] },
    { response: [{ lat: '0', lon: '0' }] },
  ])('does not turn missing, ambiguous or invalid responses into evidence (%j)', async ({ response }) => {
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => response });
    expect(await lookupAddressCoordinates(gym.address)).toBeNull();
  });

  it('uses a short negative cache for temporary failures', async () => {
    mocks.fetch.mockRejectedValue(new Error('offline'));
    expect(await lookupAddressCoordinates(gym.address)).toBeNull();
    expect(mocks.set.mock.calls.at(-1)).toEqual([expect.any(String), 'null', 'EX', 300, 'NX']);
  });

  it('requires shared Redis rather than issuing uncoordinated requests', async () => {
    mocks.clients.mockImplementation(() => {
      throw new Error('offline');
    });
    expect(await lookupAddressCoordinates(gym.address)).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('supports changing the provider without a client update', async () => {
    vi.stubEnv('GYM_GEOCODING_URL', 'https://geocoder.boardsesh.invalid/search');
    await lookupAddressCoordinates(gym.address);
    expect(mocks.fetch.mock.calls[0][0].origin).toBe('https://geocoder.boardsesh.invalid');
  });
});
