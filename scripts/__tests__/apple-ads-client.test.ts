import { afterEach, describe, expect, it, vi } from 'vitest';
const { factory, sdk } = vi.hoisted(() => ({
  factory: vi.fn(),
  sdk: Object.fromEntries(
    [
      'campaignsQueryPost',
      'adgroupsQueryPost',
      'keywordsQueryPost',
      'creativesQueryPost',
      'adsQueryPost',
      'queryProductPages',
      'queryProductPageLocaleDetails',
      'eligibilitiesAppsQueryPost',
      'adAccountsIdGet',
      ...['campaigns', 'adgroups', 'keywords', 'creatives', 'ads'].flatMap((kind) => [
        `${kind}Post`,
        `${kind}IdGet`,
        `${kind}IdPut`,
      ]),
    ].map((method) => [method, vi.fn()]),
  ),
}));
vi.mock('@apple/apple-ads-platform', () => ({ createAppleAdsApi: factory }));
import { appleAdsClient } from '../lib/apple-ads-client';
import { validateConfig, type Kind } from '../lib/apple-ads';
import { readFileSync } from 'node:fs';
function config() {
  return validateConfig(JSON.parse(readFileSync('app-stores/apple/ads.json', 'utf8')));
}
async function client() {
  for (const key of ['CLIENT_ID', 'TEAM_ID', 'KEY_ID', 'PRIVATE_KEY_PATH'])
    vi.stubEnv(`APPLE_ADS_${key}`, 'secret-fixture');
  factory.mockResolvedValue(sdk);
  return appleAdsClient(config());
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});
describe('Apple Ads official SDK boundary', () => {
  it.each([
    ['campaigns', 'campaignsQueryPost'],
    ['adgroups', 'adgroupsQueryPost'],
    ['keywords', 'keywordsQueryPost'],
    ['creatives', 'creativesQueryPost'],
    ['ads', 'adsQueryPost'],
    ['pages', 'queryProductPages'],
    ['locales', 'queryProductPageLocaleDetails'],
    ['eligibilities', 'eligibilitiesAppsQueryPost'],
  ])('wires %s listing to the official method and Axios envelope', async (kind, method) => {
    const adapter = await client();
    sdk[method].mockResolvedValue({ data: { result: [{ id: 42 }], pagination: { totalCount: 1 } } });
    expect(await adapter.list(kind as Kind, { name: 'fixture' })).toEqual([{ id: 42 }]);
    expect(sdk[method]).toHaveBeenCalledWith('adAccountId=21374740', {
      filters: [{ field: 'name', operator: 'EQUALS', value: 'fixture' }],
      pagination: { offset: 0, pageSize: 200, fetchTotalCount: true },
    });
  });
  it.each(['campaigns', 'adgroups', 'keywords', 'creatives', 'ads'])(
    'reads %s by ID using the direct endpoint',
    async (kind) => {
      const adapter = await client();
      sdk[`${kind}IdGet`].mockResolvedValue({ data: { result: { id: 42 } } });
      expect(await adapter.list(kind as Kind, { id: 42 })).toEqual([{ id: 42 }]);
      expect(sdk[`${kind}IdGet`]).toHaveBeenCalledWith('42', 'adAccountId=21374740');
    },
  );
  it.each(['campaigns', 'adgroups', 'keywords', 'creatives', 'ads'])(
    'wires %s creation with account context first',
    async (kind) => {
      const adapter = await client();
      sdk[`${kind}Post`].mockResolvedValue({ data: { result: { id: 42 } } });
      expect(await adapter.create(kind as Kind, { name: 'fixture' })).toEqual({ id: 42 });
      expect(sdk[`${kind}Post`]).toHaveBeenCalledWith('adAccountId=21374740', { name: 'fixture' });
    },
  );
  it.each(['campaigns', 'adgroups', 'keywords', 'ads'])('wires %s updates with ID before context', async (kind) => {
    const adapter = await client();
    sdk[`${kind}IdPut`].mockResolvedValue({ data: { result: { id: 42 } } });
    expect(await adapter.update(kind as Kind, '42', { status: 'PAUSED' })).toEqual({ id: 42 });
    expect(sdk[`${kind}IdPut`]).toHaveBeenCalledWith('42', 'adAccountId=21374740', { status: 'PAUSED' });
  });
  it('unwraps and scopes account details', async () => {
    const adapter = await client();
    sdk.adAccountsIdGet.mockResolvedValue({ data: { result: { id: 21374740, currency: 'AUD' } } });
    expect(await adapter.account()).toEqual({ id: 21374740, currency: 'AUD' });
    expect(sdk.adAccountsIdGet).toHaveBeenCalledWith('21374740', 'adAccountId=21374740');
  });
  it('paginates without dropping resources and scopes the account', async () => {
    const adapter = await client();
    sdk.campaignsQueryPost
      .mockResolvedValueOnce({
        data: { result: Array.from({ length: 200 }, (_, index) => ({ id: index })), pagination: { totalCount: 201 } },
      })
      .mockResolvedValueOnce({ data: { result: [{ id: 200 }], pagination: { totalCount: 201 } } });
    expect(await adapter.list('campaigns', { promotedObjectId: '6761350784' })).toHaveLength(201);
    expect(sdk.campaignsQueryPost.mock.calls[1][0]).toBe('adAccountId=21374740');
    expect(sdk.campaignsQueryPost.mock.calls[1][1].pagination.offset).toBe(200);
    expect(factory.mock.calls[0][0].logger).toBeNull();
  });
  it('never blindly retries ambiguous creates or leaks response secrets', async () => {
    const adapter = await client();
    sdk.campaignsPost.mockRejectedValue({ status: 503, message: 'secret-fixture', data: { token: 'secret-fixture' } });
    await expect(adapter.create('campaigns', {})).rejects.toThrow('mutation failed (HTTP 503)');
    expect(sdk.campaignsPost).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed query results rather than treating them as empty inventory', async () => {
    const adapter = await client();
    sdk.campaignsQueryPost.mockResolvedValue({ data: {} });
    await expect(adapter.list('campaigns')).rejects.toThrow('Invalid Apple Ads query response');
  });
});
