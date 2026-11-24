import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { lookupAddressCoordinates } from '../services/gym-address-location';
import { applyRateLimit } from '../graphql/resolvers/shared/helpers';
import { gymAddressLookupQueries } from '../graphql/resolvers/social/gym-address-lookup';

vi.mock('../services/gym-address-location', () => ({ lookupAddressCoordinates: vi.fn() }));
vi.mock('../graphql/resolvers/shared/helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../graphql/resolvers/shared/helpers')>()),
  applyRateLimit: vi.fn(),
}));
const context = { connectionId: 'address-test', isAuthenticated: true, userId: 'staff' } as ConnectionContext;
const lookup = (address: string, ctx = context) =>
  gymAddressLookupQueries.lookupGymAddressCoordinates(null, { address }, ctx);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(lookupAddressCoordinates).mockResolvedValue({ latitude: 52.37, longitude: 4.9 });
});

describe('explicit authenticated map address lookup', () => {
  it('refuses anonymous callers before rate limiting or contacting the provider', async () => {
    await expect(lookup('Damrak 1 Amsterdam', { ...context, isAuthenticated: false })).rejects.toThrow(
      'Authentication',
    );
    expect(applyRateLimit).not.toHaveBeenCalled();
    expect(lookupAddressCoordinates).not.toHaveBeenCalled();
  });

  it.each(['', '    ', '1234', 'a'.repeat(501)])(
    'rejects an invalid bounded address without provider calls',
    async (address) => {
      await expect(lookup(address)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
      expect(lookupAddressCoordinates).not.toHaveBeenCalled();
    },
  );

  it('uses the shared provider budget after the authenticated per-user limit', async () => {
    expect(await lookup('  Damrak 1 Amsterdam  ')).toEqual({ latitude: 52.37, longitude: 4.9 });
    expect(applyRateLimit).toHaveBeenCalledWith(context, 10, 'lookupGymAddressCoordinates');
    expect(lookupAddressCoordinates).toHaveBeenCalledWith('Damrak 1 Amsterdam');
    expect(vi.mocked(applyRateLimit).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(lookupAddressCoordinates).mock.invocationCallOrder[0],
    );
  });

  it('does not contact the provider after a rate-limit rejection', async () => {
    vi.mocked(applyRateLimit).mockRejectedValueOnce(new Error('rate limited'));
    await expect(lookup('Damrak 1 Amsterdam')).rejects.toThrow('rate limited');
    expect(lookupAddressCoordinates).not.toHaveBeenCalled();
  });

  it('returns unavailable for an ambiguous match or unavailable provider', async () => {
    vi.mocked(lookupAddressCoordinates).mockResolvedValueOnce(null);
    expect(await lookup('Damrak 1 Amsterdam')).toBeNull();
  });
});
