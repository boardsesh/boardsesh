import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  at,
  campaignName,
  money,
  reconcile,
  validateConfig,
  type AdsClient,
  type AdsConfig,
  type Kind,
  type Row,
} from '../lib/apple-ads';
const references = { kilter: 'Boardsesh Kilter' };
function fixture(): AdsConfig {
  return validateConfig({
    version: 1,
    adAccountId: 21374740,
    appId: 6761350784,
    currency: 'AUD',
    namespace: 'Boardsesh Managed',
    legacyCampaignIds: [2144850955, 2143695506],
    campaigns: [
      {
        country: 'US',
        dailyBudget: '50.00',
        status: 'ENABLED',
        locale: 'en-US',
        groups: [{ target: 'kilter', maxCptBid: '1.00', status: 'ENABLED', keywords: ['kilter', 'kilterboard'] }],
      },
    ],
  });
}
class FakeClient implements AdsClient {
  writes: Row[] = [];
  records: Record<Kind, Row[]> = {
    campaigns: [],
    adgroups: [],
    keywords: [],
    creatives: [],
    ads: [],
    pages: [{ id: 'cpp-kilter', adamId: 6761350784, name: 'Boardsesh Kilter', state: 'VISIBLE' }],
    locales: [
      {
        productPageId: 'cpp-kilter',
        adamId: 6761350784,
        language: 'en',
        languageCode: 'en-US',
        deviceClasses: ['IPHONE'],
        assetsByDevice: { iphone_6_7: { assets: [{ assetId: 'asset' }] } },
      },
    ],
    eligibilities: [
      {
        adamId: 6761350784,
        state: 'ELIGIBLE',
        supplySource: 'APPSTORE',
        countryOrRegion: 'US',
        supplyPlacement: 'APPSTORE_SEARCH_RESULTS',
        deviceClass: 'IPHONE',
      },
    ],
  };
  async account() {
    return { id: 21374740, currency: 'AUD' };
  }
  async list(kind: Kind, filters: Row = {}) {
    return structuredClone(
      this.records[kind].filter((resource) =>
        Object.entries(filters).every(([key, expected]) =>
          key === 'language'
            ? resource.language === expected
            : resource[key] === expected || String(resource[key]) === String(expected),
        ),
      ),
    );
  }
  async create(kind: Kind, payload: Row) {
    const resource: Row = {
      ...structuredClone(payload),
      id: this.writes.length + 100,
      ...(kind === 'creatives' ? { eligibility: { status: 'ELIGIBLE' }, systemStatus: 'VALID' } : {}),
      ...(kind === 'ads' ? { systemStatus: 'RUNNING', systemStatusReasons: [] } : {}),
    };
    this.records[kind].push(resource);
    this.writes.push({ kind, operation: 'create', resource });
    return structuredClone(resource);
  }
  async update(kind: Kind, identifier: string, payload: Row) {
    const resource = this.records[kind].find((candidate) => String(candidate.id) === identifier)!;
    Object.assign(resource, structuredClone(payload));
    this.writes.push({ kind, operation: 'update', identifier, payload });
    return structuredClone(resource);
  }
}
describe('Apple Ads manifest', () => {
  it('expands the agreed four campaigns, budgets and sixteen groups', () => {
    const config = validateConfig(JSON.parse(readFileSync('app-stores/apple/ads.json', 'utf8')));
    expect(config.campaigns.map((campaign) => [campaign.country, money(campaign.dailyBudget)])).toEqual([
      ['US', '50.00'],
      ['AU', '20.00'],
      ['CA', '15.00'],
      ['DE', '15.00'],
    ]);
    expect(config.campaigns.flatMap((campaign) => campaign.groups)).toHaveLength(16);
  });
  it.each(['-1', '0', '1.001', 'NaN', 2])('rejects unsafe monetary input %s', (amount) =>
    expect(() => money(amount)).toThrow(),
  );
  it('rejects duplicate countries and keywords', () => {
    const config = fixture();
    config.campaigns.push(config.campaigns[0]);
    expect(() => validateConfig(config)).toThrow();
    const keywords = fixture();
    keywords.campaigns[0].groups[0].keywords.push('KILTER');
    expect(() => validateConfig(keywords)).toThrow();
  });
});
describe('Apple Ads reconciliation', () => {
  it('plans complete creation without writes', async () => {
    const client = new FakeClient();
    const report = await reconcile(fixture(), references, client, 'plan');
    expect(client.writes).toEqual([]);
    expect(report.changes.some((change) => change.kind === 'campaigns')).toBe(true);
  });
  it('creates the configured CPP group and reruns without duplicate resources', async () => {
    const client = new FakeClient();
    await reconcile(fixture(), references, client, 'apply');
    expect(client.records.campaigns[0].status).toBe('ENABLED');
    expect(client.records.adgroups[0].status).toBe('ENABLED');
    expect(at(client.records.creatives[0], 'destination', 'parameters', 'productPageId')).toBe('cpp-kilter');
    const count = client.writes.length;
    await reconcile(fixture(), references, client, 'apply');
    expect(client.writes).toHaveLength(count);
  });
  it('fails before writes for unknown app campaigns', async () => {
    const client = new FakeClient();
    client.records.campaigns.push({ id: 99, name: 'Renamed managed campaign', promotedObjectId: '6761350784' });
    await expect(reconcile(fixture(), references, client, 'apply')).rejects.toThrow();
    expect(client.writes).toEqual([]);
  });
  it('leaves legacy campaigns untouched', async () => {
    const client = new FakeClient();
    const legacy = { id: 2144850955, name: 'First campaign', promotedObjectId: '6761350784', status: 'ENABLED' };
    client.records.campaigns.push(legacy);
    await reconcile(fixture(), references, client, 'apply');
    expect(legacy).toEqual({
      id: 2144850955,
      name: 'First campaign',
      promotedObjectId: '6761350784',
      status: 'ENABLED',
    });
  });
  it('blocks missing CPPs before creating campaigns', async () => {
    const client = new FakeClient();
    client.records.pages = [];
    await expect(reconcile(fixture(), references, client, 'apply')).rejects.toThrow();
    expect(client.writes).toEqual([]);
  });
  it('blocks duplicate campaign identities before writes', async () => {
    const client = new FakeClient();
    const name = campaignName(fixture(), fixture().campaigns[0]);
    client.records.campaigns.push(...[1, 2].map((id) => ({ id, name, promotedObjectId: '6761350784' })));
    await expect(reconcile(fixture(), references, client, 'apply')).rejects.toThrow();
    expect(client.writes).toEqual([]);
  });
  it('pauses retired keywords without deleting their history', async () => {
    const client = new FakeClient();
    await reconcile(fixture(), references, client, 'apply');
    const config = fixture();
    config.campaigns[0].groups[0].keywords = ['kilter'];
    await reconcile(config, references, client, 'apply');
    expect(client.records.keywords.find((keyword) => keyword.text === 'kilterboard')?.status).toBe('PAUSED');
    expect(client.records.keywords).toHaveLength(2);
  });
});

describe('Apple Ads failure boundaries', () => {
  it('audits current inventory without requiring a visible CPP or proposing changes', async () => {
    const client = new FakeClient();
    client.records.pages = [];
    client.records.campaigns.push({ id: 2144850955, name: 'First campaign', promotedObjectId: '6761350784' });
    const report = await reconcile(fixture(), references, client, 'audit');
    expect(report.campaigns).toHaveLength(1);
    expect(report.changes).toEqual([]);
    expect(client.writes).toEqual([]);
  });
  it('holds groups paused while the custom creative awaits approval', async () => {
    class PendingClient extends FakeClient {
      override async create(kind: Kind, payload: Row) {
        const resource = await super.create(kind, payload);
        if (kind === 'creatives') {
          Object.assign(this.records.creatives.at(-1)!, {
            eligibility: { status: 'PENDING' },
            systemStatus: 'PENDING',
          });
          return structuredClone(this.records.creatives.at(-1)!);
        }
        return resource;
      }
    }
    const client = new PendingClient();
    const report = await reconcile(fixture(), references, client, 'apply');
    expect(client.records.adgroups[0].status).toBe('PAUSED');
    expect(report.pending).toEqual(['US/kilter']);
  });
  it('resumes an ambiguous successful campaign create without duplicating it', async () => {
    class InterruptedClient extends FakeClient {
      interrupted = false;
      override async create(kind: Kind, payload: Row) {
        const resource = await super.create(kind, payload);
        if (!this.interrupted) {
          this.interrupted = true;
          throw new Error('Ambiguous transport failure');
        }
        return resource;
      }
    }
    const client = new InterruptedClient();
    await expect(reconcile(fixture(), references, client, 'apply')).rejects.toThrow('Ambiguous');
    await reconcile(fixture(), references, client, 'apply');
    expect(client.records.campaigns).toHaveLength(1);
    expect(client.records.adgroups).toHaveLength(1);
  });
  it('fails mismatched creative identity before changing any configured bids', async () => {
    const client = new FakeClient();
    await reconcile(fixture(), references, client, 'apply');
    const count = client.writes.length;
    client.records.creatives[0].destination = { parameters: { adamId: '6761350784', productPageId: 'foreign' } };
    const config = fixture();
    config.campaigns[0].groups[0].maxCptBid = '2.00';
    await expect(reconcile(config, references, client, 'apply')).rejects.toThrow('Creative identity');
    expect(client.writes).toHaveLength(count);
  });
  it('fails duplicate remote keyword identities before any mutations', async () => {
    const client = new FakeClient();
    await reconcile(fixture(), references, client, 'apply');
    client.records.keywords.push({ ...client.records.keywords[0], id: 999 });
    const count = client.writes.length;
    await expect(reconcile(fixture(), references, client, 'apply')).rejects.toThrow('Duplicate keyword');
    expect(client.writes).toHaveLength(count);
  });
  it('creates all sixteen groups and reruns without changes', async () => {
    const config = validateConfig(JSON.parse(readFileSync('app-stores/apple/ads.json', 'utf8')));
    const client = new FakeClient();
    const allReferences = {
      kilter: 'Boardsesh Kilter',
      tension: 'Boardsesh Tension',
      moonboard: 'Boardsesh MoonBoard',
      spray: 'Boardsesh Spray Wall',
    };
    client.records.pages = Object.entries(allReferences).map(([target, name]) => ({
      id: `cpp-${target}`,
      name,
      adamId: config.appId,
      state: 'VISIBLE',
    }));
    client.records.locales = client.records.pages.flatMap((page) =>
      ['en-US', 'de-DE'].map((languageCode) => ({
        ...client.records.locales[0],
        productPageId: page.id,
        languageCode,
      })),
    );
    client.records.eligibilities = config.campaigns.map((campaign) => ({
      ...client.records.eligibilities[0],
      countryOrRegion: campaign.country,
    }));
    await reconcile(config, allReferences, client, 'apply');
    expect(client.records.campaigns).toHaveLength(4);
    expect(client.records.adgroups).toHaveLength(16);
    const count = client.writes.length;
    await reconcile(config, allReferences, client, 'apply');
    expect(client.writes).toHaveLength(count);
  });
});

describe('emergency pause without CPP dependencies', () => {
  it.each(['campaign', 'group'])('pauses existing %s even when CPP is hidden or missing', async (scope) => {
    const client = new FakeClient();
    const config = fixture();
    await reconcile(config, references, client, 'apply');
    client.records.pages = [];
    client.records.eligibilities = [];
    const count = client.writes.length;
    if (scope === 'campaign') config.campaigns[0].status = 'PAUSED';
    else config.campaigns[0].groups[0].status = 'PAUSED';
    await reconcile(config, references, client, 'apply');
    expect(client.writes.slice(count)).toHaveLength(1);
    expect(client.writes.at(-1)?.payload).toEqual({ status: 'PAUSED' });
    expect(scope === 'campaign' ? client.records.campaigns[0].status : client.records.adgroups[0].status).toBe(
      'PAUSED',
    );
  });
  it('does not create nonexistent paused campaigns', async () => {
    const client = new FakeClient();
    client.records.pages = [];
    const config = fixture();
    config.campaigns[0].status = 'PAUSED';
    await reconcile(config, references, client, 'apply');
    expect(client.writes).toEqual([]);
  });
});
