import type {
  AdGroupPatch,
  AdPatch,
  CampaignPatch,
  LiveAd,
  LiveAdGroup,
  LiveCampaign,
  PaidSocialClient,
  PaidSocialConfig,
  Platform,
  Targeting,
} from '../../lib/paid-social';

export interface FakeCall {
  method: string;
  id?: string;
  payload?: unknown;
}

export interface FakeAccount {
  campaigns: LiveCampaign[];
  adGroups: LiveAdGroup[];
  ads: LiveAd[];
  calls: FakeCall[];
  /** Make a write report success without landing, to exercise read-back. */
  dropWrites?: Set<string>;
}

export function emptyAccount(): FakeAccount {
  return { campaigns: [], adGroups: [], ads: [], calls: [] };
}

export function liveTargeting(overrides: Partial<Targeting> = {}): Targeting {
  return {
    countries: ['US'],
    placements: ['FEED'],
    interests: [],
    communities: ['climbing'],
    ageMin: null,
    ageMax: null,
    ...overrides,
  };
}

export function fakeClient(
  platform: Platform,
  state: FakeAccount,
  account: { id: string; currency: string } = { id: 'acct1', currency: 'AUD' },
): PaidSocialClient {
  let sequence = 0;
  const newId = (prefix: string) => `${prefix}-new-${++sequence}`;
  const drop = (method: string) => state.dropWrites?.has(method) ?? false;
  function patchStatus<T extends { status: string }>(entity: T, status: string | undefined) {
    if (status !== undefined) entity.status = status;
  }
  return {
    platform,
    async account() {
      return account;
    },
    async listCampaigns() {
      return state.campaigns.map((campaign) => ({ ...campaign }));
    },
    async listAdGroups(campaignId) {
      return state.adGroups.filter((group) => group.campaignId === campaignId).map((group) => ({ ...group }));
    },
    async listAds(adGroupId) {
      return state.ads.filter((ad) => ad.adGroupId === adGroupId).map((ad) => ({ ...ad }));
    },
    async createCampaign(spec) {
      state.calls.push({ method: 'createCampaign', payload: spec });
      const id = newId('campaign');
      state.campaigns.push({
        id,
        name: spec.name,
        status: 'PAUSED',
        objective: spec.objective,
        dailyBudgetCents: spec.dailyBudgetCents,
        lifetimeBudget: false,
      });
      return id;
    },
    async updateCampaign(id, patch: CampaignPatch) {
      state.calls.push({ method: 'updateCampaign', id, payload: patch });
      if (drop('updateCampaign')) return;
      const campaign = state.campaigns.find((candidate) => candidate.id === id)!;
      if (patch.name !== undefined) campaign.name = patch.name;
      if (patch.dailyBudgetCents !== undefined) campaign.dailyBudgetCents = patch.dailyBudgetCents;
      patchStatus(campaign, patch.status);
    },
    async createAdGroup(campaignId, spec) {
      state.calls.push({ method: 'createAdGroup', id: campaignId, payload: spec });
      const id = newId('group');
      state.adGroups.push({
        id,
        name: spec.name,
        campaignId,
        status: 'PAUSED',
        dailyBudgetCents: spec.dailyBudgetCents,
        lifetimeBudget: false,
        endDate: spec.endTime?.slice(0, 10) ?? null,
        targeting: spec.targeting,
      });
      return id;
    },
    async updateAdGroup(id, patch: AdGroupPatch) {
      state.calls.push({ method: 'updateAdGroup', id, payload: patch });
      if (drop('updateAdGroup')) return;
      const group = state.adGroups.find((candidate) => candidate.id === id)!;
      if (patch.name !== undefined) group.name = patch.name;
      if (patch.dailyBudgetCents !== undefined) group.dailyBudgetCents = patch.dailyBudgetCents;
      if (patch.endTime !== undefined) group.endDate = patch.endTime?.slice(0, 10) ?? null;
      if (patch.targeting !== undefined) group.targeting = patch.targeting;
      patchStatus(group, patch.status);
    },
    async createCreative(spec) {
      state.calls.push({
        method: 'createCreative',
        payload: { name: spec.name, urlTags: spec.urlTags, link: spec.link },
      });
      return `creative:${spec.name}`;
    },
    async createAd(adGroupId, spec) {
      state.calls.push({ method: 'createAd', id: adGroupId, payload: spec });
      const id = newId('ad');
      const creativeName = spec.creativeId.startsWith('creative:') ? spec.creativeId.slice('creative:'.length) : null;
      state.ads.push({
        id,
        name: spec.name,
        adGroupId,
        status: 'PAUSED',
        destination: platform === 'reddit' ? spec.destination : null,
        creativeId: spec.creativeId,
        creativeName,
      });
      return id;
    },
    async updateAd(id, patch: AdPatch) {
      state.calls.push({ method: 'updateAd', id, payload: patch });
      if (drop('updateAd')) return;
      const ad = state.ads.find((candidate) => candidate.id === id)!;
      if (patch.destination !== undefined) ad.destination = patch.destination;
      if (patch.creativeId !== undefined) {
        ad.creativeId = patch.creativeId;
        ad.creativeName = patch.creativeId.startsWith('creative:') ? patch.creativeId.slice('creative:'.length) : null;
      }
      patchStatus(ad, patch.status);
    },
  };
}

export function redditConfig(overrides: Partial<PaidSocialConfig> = {}): PaidSocialConfig {
  return {
    version: 1,
    platform: 'reddit',
    adAccountId: 'acct1',
    currency: 'AUD',
    namespace: 'Boardsesh Managed',
    maxDailyBudgetTotal: '50.00',
    allowBudgetJump: false,
    adoptCampaignIds: [],
    reddit: { pixelId: 'a2_pixel' },
    campaigns: [
      {
        code: 'nov26-launch',
        status: 'PAUSED',
        objective: 'CLICKS',
        startDate: '2026-11-01',
        endDate: '2026-11-30',
        adGroups: [
          {
            name: 'homewalls',
            status: 'PAUSED',
            dailyBudget: '10.00',
            targeting: { countries: ['US'], placements: ['FEED'], interests: [], communities: ['climbing'] },
            ads: [{ name: 'homewalls-ad-1', status: 'PAUSED', creative: { postId: 't3_abc123' } }],
          },
        ],
      },
    ],
    ...overrides,
  };
}
