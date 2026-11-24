import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { lookupAddressCoordinates, resolveGymAddressLocation } from '../services/gym-address-location';

const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), clients: vi.fn(), fetch: vi.fn() }));
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
  });

  it('holds an address lease longer than the HTTP deadline', async () => {
    mocks.set.mockResolvedValueOnce(null);
    expect(await lookupAddressCoordinates(gym.address)).toBeNull();
    expect(mocks.set).toHaveBeenCalledWith(expect.stringContaining(':in-flight'), '1', 'PX', 15_000, 'NX');
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
