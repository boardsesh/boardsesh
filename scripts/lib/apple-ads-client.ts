import { createAppleAdsApi } from '@apple/apple-ads-platform';
import { at, row, type AdsClient, type AdsConfig, type Kind, type Row } from './apple-ads';
const queryMethods: Record<Kind, string> = {
  campaigns: 'campaignsQueryPost',
  adgroups: 'adgroupsQueryPost',
  keywords: 'keywordsQueryPost',
  creatives: 'creativesQueryPost',
  ads: 'adsQueryPost',
  pages: 'queryProductPages',
  locales: 'queryProductPageLocaleDetails',
  eligibilities: 'eligibilitiesAppsQueryPost',
};
type SdkMethod = (...args: unknown[]) => Promise<unknown>;
export async function appleAdsClient(config: AdsConfig): Promise<AdsClient> {
  function required(name: string) {
    const credential = process.env[name];
    if (!credential) throw new Error(`Missing ${name}`);
    return credential;
  }
  const sdk = await createAppleAdsApi({
    authMode: 'key',
    clientId: required('APPLE_ADS_CLIENT_ID'),
    teamId: required('APPLE_ADS_TEAM_ID'),
    keyId: required('APPLE_ADS_KEY_ID'),
    privateKeyPath: required('APPLE_ADS_PRIVATE_KEY_PATH'),
    logger: null,
    apiTimeout: 30_000,
  });
  const context = `adAccountId=${config.adAccountId}`;
  async function call(name: string, args: unknown[], read: boolean): Promise<Row> {
    const method: unknown = (sdk as unknown as Row)[name];
    if (typeof method !== 'function') throw new Error('Unsupported pinned Apple Ads SDK operation');
    for (let attempt = 0; ; attempt++) {
      try {
        return row(at(await (method as SdkMethod).apply(sdk, args), 'data'));
      } catch (error: unknown) {
        const status = Number(at(error, 'status'));
        if (read && attempt < 2 && [429, 500, 502, 503, 504].includes(status)) {
          await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 2000));
          continue;
        }
        // Do not print SDK error bodies, URLs, headers or authentication details.
        throw new Error(
          `Apple Ads ${read ? 'read' : 'mutation'} failed${Number.isInteger(status) && status > 0 ? ` (HTTP ${status})` : ''}; rerun plan to reconcile state`,
        );
      }
    }
  }
  return {
    async account() {
      return row((await call('adAccountsIdGet', [String(config.adAccountId), context], true)).result);
    },
    async list(kind, filters = {}) {
      if (
        Object.keys(filters).length === 1 &&
        (typeof filters.id === 'string' || typeof filters.id === 'number') &&
        ['campaigns', 'adgroups', 'keywords', 'creatives', 'ads'].includes(kind)
      ) {
        const response = await call(`${kind}IdGet`, [String(filters.id), context], true);
        return [row(response.result)];
      }
      const resources: Row[] = [];
      for (let offset = 0; offset < 100_000; offset += 200) {
        const response = await call(
          queryMethods[kind],
          [
            context,
            {
              filters: Object.entries(filters).map(([field, criterion]) => ({
                field,
                operator: 'EQUALS',
                value: criterion,
              })),
              pagination: { offset, pageSize: 200, fetchTotalCount: true },
            },
          ],
          true,
        );
        if (!Array.isArray(response.result)) throw new Error('Invalid Apple Ads query response');
        const page = response.result.map(row);
        resources.push(...page);
        const total = at(response, 'pagination', 'totalCount');
        if (page.length < 200 || (typeof total === 'number' && resources.length >= total)) return resources;
      }
      throw new Error('Apple Ads pagination exceeded bounded inventory');
    },
    async create(kind, payload) {
      if (!['campaigns', 'adgroups', 'keywords', 'creatives', 'ads'].includes(kind))
        throw new Error('Read-only Apple Ads resource');
      return row((await call(`${kind}Post`, [context, payload], false)).result);
    },
    async update(kind, identifier, payload) {
      if (!['campaigns', 'adgroups', 'keywords', 'ads'].includes(kind)) throw new Error('Immutable Apple Ads resource');
      return row((await call(`${kind}IdPut`, [identifier, context, payload], false)).result);
    },
  };
}
