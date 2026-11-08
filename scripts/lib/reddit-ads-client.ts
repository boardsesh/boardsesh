/**
 * Reddit Ads API v3 client (https://ads-api.reddit.com/api/v3, schema at
 * /api/v3/openapi.json). Money is microcurrency on the wire and cents here.
 * Auth is the OAuth refresh-token flow against
 * https://www.reddit.com/api/v1/access_token with the adsread + adsedit scopes.
 */
import { assertSameOrigin, requestJson, type FetchLike } from './paid-social-http';
import type {
  AdGroupPatch,
  AdGroupWrite,
  AdPatch,
  AdWrite,
  CampaignPatch,
  CampaignWrite,
  LiveAd,
  LiveAdGroup,
  LiveCampaign,
  PaidSocialClient,
  PaidSocialConfig,
  Targeting,
} from './paid-social';

export const REDDIT_ADS_ORIGIN = 'https://ads-api.reddit.com';
export const REDDIT_ADS_BASE = `${REDDIT_ADS_ORIGIN}/api/v3`;
export const REDDIT_TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
export const REDDIT_SECRET_NAMES = [
  'REDDIT_ADS_CLIENT_ID',
  'REDDIT_ADS_CLIENT_SECRET',
  'REDDIT_ADS_REFRESH_TOKEN',
] as const;
const USER_AGENT = 'boardsesh-ads-as-code/1.0 (+https://www.boardsesh.com)';
const MICROS_PER_CENT = 10_000;

type Row = Record<string, unknown>;

export interface RedditCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export function redditCredentialsFromEnv(env: NodeJS.ProcessEnv): RedditCredentials {
  const missing = REDDIT_SECRET_NAMES.filter((name) => !env[name]);
  if (missing.length) throw new Error(`Missing ${missing.join(', ')}`);
  return {
    clientId: env.REDDIT_ADS_CLIENT_ID!,
    clientSecret: env.REDDIT_ADS_CLIENT_SECRET!,
    refreshToken: env.REDDIT_ADS_REFRESH_TOKEN!,
  };
}

function str(input: unknown): string {
  return typeof input === 'string' ? input : typeof input === 'number' ? String(input) : '';
}
function strings(input: unknown): string[] {
  return Array.isArray(input) ? input.filter((entry): entry is string => typeof entry === 'string') : [];
}
function microsToCents(input: unknown): number | null {
  return typeof input === 'number' && Number.isFinite(input) ? Math.round(input / MICROS_PER_CENT) : null;
}
function dateOf(input: unknown): string | null {
  if (typeof input !== 'string' || !input) return null;
  const parsed = new Date(input);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}
const REDDIT_MODELLED_TARGETING = new Set(['geolocations', 'locations', 'interests', 'communities']);
/** Any other non-empty field (keywords, audiences, exclusions, devices, expand_targeting...) would be dropped by a rewrite. */
function unmanagedTargeting(targeting: Row): string[] {
  return Object.entries(targeting)
    .filter(
      ([key, value]) =>
        !REDDIT_MODELLED_TARGETING.has(key) &&
        value !== null &&
        value !== undefined &&
        value !== false &&
        !(Array.isArray(value) && value.length === 0),
    )
    .map(([key]) => key);
}
function targetingOf(input: unknown): Targeting {
  const targeting = (input && typeof input === 'object' ? input : {}) as Row;
  return {
    unmanaged: unmanagedTargeting(targeting),
    countries: strings(targeting.geolocations),
    placements: strings(targeting.locations),
    interests: strings(targeting.interests),
    communities: strings(targeting.communities),
    ageMin: null,
    ageMax: null,
  };
}
function targetingBody(targeting: Targeting): Row {
  return {
    geolocations: targeting.countries,
    locations: targeting.placements,
    interests: targeting.interests,
    communities: targeting.communities,
  };
}

export function createRedditAdsClient(
  config: PaidSocialConfig,
  credentials: RedditCredentials,
  fetchImpl: FetchLike = fetch,
  sleep?: (milliseconds: number) => Promise<void>,
): PaidSocialClient {
  if (config.platform !== 'reddit') throw new Error('Reddit client needs a Reddit config');
  const secrets = [credentials.clientId, credentials.clientSecret, credentials.refreshToken];
  let accessToken: string | undefined;

  async function token(): Promise<string> {
    if (accessToken) return accessToken;
    const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64');
    const body = await requestJson(
      fetchImpl,
      REDDIT_TOKEN_URL,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT,
        },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: credentials.refreshToken }).toString(),
      },
      { label: 'Reddit token refresh', read: true, secrets, sleep },
    );
    if (typeof body.access_token !== 'string' || !body.access_token)
      throw new Error('Reddit token refresh returned no token');
    accessToken = body.access_token;
    secrets.push(accessToken);
    return accessToken;
  }

  async function call(method: 'GET' | 'POST' | 'PATCH', url: string, label: string, data?: Row): Promise<Row> {
    return requestJson(
      fetchImpl,
      url,
      {
        method,
        headers: {
          Authorization: `Bearer ${await token()}`,
          'User-Agent': USER_AGENT,
          ...(data ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(data ? { body: JSON.stringify({ data }) } : {}),
      },
      { label: `Reddit ${label}`, read: method === 'GET', secrets, sleep },
    );
  }

  async function list(path: string, label: string, query: Record<string, string> = {}): Promise<Row[]> {
    const rows: Row[] = [];
    let url: string | null = `${REDDIT_ADS_BASE}${path}?${new URLSearchParams({ ...query, 'page.size': '500' })}`;
    for (let page = 0; url; page++) {
      if (page >= 50) throw new Error(`Reddit ${label} pagination exceeded 50 pages`);
      const body: Row = await call('GET', url, label);
      if (!Array.isArray(body.data)) throw new Error(`Reddit ${label} returned no data list`);
      rows.push(...(body.data as Row[]));
      const pagination = body.pagination as Row | undefined;
      const next = pagination?.next_url;
      url = typeof next === 'string' && next ? assertSameOrigin(next, REDDIT_ADS_ORIGIN) : null;
    }
    return rows;
  }

  async function created(body: Row, label: string): Promise<string> {
    const id = str((body.data as Row | undefined)?.id);
    if (!id) throw new Error(`Reddit ${label} returned no id; rerun plan before retrying`);
    return id;
  }

  if (!config.adAccountId) throw new Error('Set adAccountId in the Reddit config before a live action');
  const account = encodeURIComponent(config.adAccountId);
  const pixelId = config.reddit?.pixelId ?? null;

  return {
    platform: 'reddit',
    async account() {
      const body = await call('GET', `${REDDIT_ADS_BASE}/ad_accounts/${account}`, 'ad account read');
      const data = (body.data ?? {}) as Row;
      return { id: str(data.id), currency: str(data.currency) };
    },
    async listCampaigns(): Promise<LiveCampaign[]> {
      return (await list(`/ad_accounts/${account}/campaigns`, 'campaign list')).map((row) => ({
        id: str(row.id),
        name: str(row.name),
        status: str(row.configured_status),
        objective: str(row.objective),
        dailyBudgetCents:
          row.is_campaign_budget_optimization === true && row.goal_type === 'DAILY_SPEND'
            ? microsToCents(row.goal_value)
            : null,
        lifetimeBudget: row.goal_type === 'LIFETIME_SPEND',
      }));
    },
    async listAdGroups(campaignId): Promise<LiveAdGroup[]> {
      return (await list(`/ad_accounts/${account}/ad_groups`, 'ad group list', { campaign_id: campaignId }))
        .filter((row) => str(row.campaign_id) === campaignId)
        .map((row) => ({
          id: str(row.id),
          name: str(row.name),
          campaignId: str(row.campaign_id),
          status: str(row.configured_status),
          dailyBudgetCents:
            row.is_campaign_budget_optimization === true || row.goal_type !== 'DAILY_SPEND'
              ? null
              : microsToCents(row.goal_value),
          lifetimeBudget: row.goal_type === 'LIFETIME_SPEND',
          endDate: dateOf(row.end_time),
          targeting: targetingOf(row.targeting),
        }));
    },
    async listAds(adGroupId): Promise<LiveAd[]> {
      return (await list(`/ad_accounts/${account}/ads`, 'ad list', { ad_group_id: adGroupId }))
        .filter((row) => str(row.ad_group_id) === adGroupId)
        .map((row) => ({
          id: str(row.id),
          name: str(row.name),
          adGroupId: str(row.ad_group_id),
          status: str(row.configured_status),
          destination: typeof row.click_url === 'string' ? row.click_url : null,
          creativeId: typeof row.post_id === 'string' ? row.post_id : null,
          creativeName: null,
        }));
    },
    async createCampaign(spec: CampaignWrite) {
      const campaignBudget =
        spec.dailyBudgetCents === null
          ? {}
          : {
              is_campaign_budget_optimization: true,
              goal_type: 'DAILY_SPEND',
              goal_value: spec.dailyBudgetCents * MICROS_PER_CENT,
              bid_strategy: 'MAXIMIZE_VOLUME',
              start_time: spec.startTime,
              end_time: spec.endTime,
            };
      const body = await call('POST', `${REDDIT_ADS_BASE}/ad_accounts/${account}/campaigns`, 'campaign create', {
        name: spec.name,
        objective: spec.objective,
        configured_status: 'PAUSED',
        ...campaignBudget,
      });
      return created(body, 'campaign create');
    },
    async updateCampaign(id, patch: CampaignPatch) {
      await call('PATCH', `${REDDIT_ADS_BASE}/campaigns/${encodeURIComponent(id)}`, 'campaign update', {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.status !== undefined ? { configured_status: patch.status } : {}),
        ...(patch.dailyBudgetCents !== undefined ? { goal_value: patch.dailyBudgetCents * MICROS_PER_CENT } : {}),
      });
    },
    async createAdGroup(campaignId, spec: AdGroupWrite) {
      if (!pixelId) throw new Error('reddit.pixelId is required to create an ad group');
      const body = await call('POST', `${REDDIT_ADS_BASE}/ad_accounts/${account}/ad_groups`, 'ad group create', {
        campaign_id: campaignId,
        name: spec.name,
        configured_status: 'PAUSED',
        bid_strategy: 'MAXIMIZE_VOLUME',
        bid_type: 'CPC',
        ...(spec.dailyBudgetCents === null
          ? {}
          : { goal_type: 'DAILY_SPEND', goal_value: spec.dailyBudgetCents * MICROS_PER_CENT }),
        start_time: spec.startTime,
        end_time: spec.endTime,
        targeting: targetingBody(spec.targeting),
        conversion_pixel_id: pixelId,
      });
      return created(body, 'ad group create');
    },
    async updateAdGroup(id, patch: AdGroupPatch) {
      await call('PATCH', `${REDDIT_ADS_BASE}/ad_groups/${encodeURIComponent(id)}`, 'ad group update', {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.status !== undefined ? { configured_status: patch.status } : {}),
        ...(patch.dailyBudgetCents !== undefined
          ? { goal_type: 'DAILY_SPEND', goal_value: patch.dailyBudgetCents * MICROS_PER_CENT }
          : {}),
        ...(patch.endTime !== undefined ? { end_time: patch.endTime } : {}),
        ...(patch.targeting !== undefined ? { targeting: targetingBody(patch.targeting) } : {}),
      });
    },
    async createCreative() {
      throw new Error('Reddit ads reference an existing post (postId); creative upload is not supported');
    },
    async createAd(adGroupId, spec: AdWrite) {
      const body = await call('POST', `${REDDIT_ADS_BASE}/ad_accounts/${account}/ads`, 'ad create', {
        ad_group_id: adGroupId,
        name: spec.name,
        configured_status: 'PAUSED',
        post_id: spec.creativeId,
        click_url: spec.destination,
      });
      return created(body, 'ad create');
    },
    async updateAd(id, patch: AdPatch) {
      await call('PATCH', `${REDDIT_ADS_BASE}/ads/${encodeURIComponent(id)}`, 'ad update', {
        ...(patch.status !== undefined ? { configured_status: patch.status } : {}),
        ...(patch.destination !== undefined ? { click_url: patch.destination } : {}),
        ...(patch.creativeId !== undefined ? { post_id: patch.creativeId } : {}),
      });
    },
  };
}
