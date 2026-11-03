/**
 * Meta Marketing API client (Graph API v26.0) for Instagram-only ad sets.
 * Budgets are minor units on the wire (x100 for the two-decimal currencies the
 * config allows) and cents here. Auth is a System User access token sent as a
 * Bearer header, never as an access_token query parameter, so no URL we build
 * or follow carries it.
 */
import { assertSameOrigin, requestJson, type FetchLike } from './paid-social-http';
import type {
  AdGroupPatch,
  AdGroupWrite,
  AdPatch,
  AdWrite,
  CampaignPatch,
  CampaignWrite,
  CreativeWrite,
  LiveAd,
  LiveAdGroup,
  LiveCampaign,
  PaidSocialClient,
  PaidSocialConfig,
  Targeting,
} from './paid-social';

export const META_GRAPH_VERSION = 'v26.0';
export const META_GRAPH_ORIGIN = 'https://graph.facebook.com';
export const META_GRAPH_BASE = `${META_GRAPH_ORIGIN}/${META_GRAPH_VERSION}`;
export const META_SECRET_NAMES = ['META_ADS_ACCESS_TOKEN'] as const;

type Row = Record<string, unknown>;

export function metaTokenFromEnv(env: NodeJS.ProcessEnv): string {
  if (!env.META_ADS_ACCESS_TOKEN) throw new Error('Missing META_ADS_ACCESS_TOKEN');
  return env.META_ADS_ACCESS_TOKEN;
}

function str(input: unknown): string {
  return typeof input === 'string' ? input : typeof input === 'number' ? String(input) : '';
}
function strings(input: unknown): string[] {
  return Array.isArray(input) ? input.filter((entry): entry is string => typeof entry === 'string') : [];
}
function minorToCents(input: unknown): number | null {
  const amount = Number(input);
  return input !== undefined && input !== null && input !== '' && Number.isFinite(amount) && amount > 0 ? amount : null;
}
function dateOf(input: unknown): string | null {
  if (typeof input !== 'string' || !input) return null;
  const parsed = new Date(input.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}
function row(input: unknown): Row {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Row) : {};
}

/** Anything we do not manage (other platforms, regions, custom audiences) shows up as a marker so the plan rewrites it. */
/** Targeting keys the config models, or that Meta adds on its own without narrowing who sees the ad. */
const META_MODELLED_TARGETING = new Set([
  'geo_locations',
  'age_min',
  'age_max',
  'publisher_platforms',
  'instagram_positions',
  'flexible_spec',
  'interests',
  'targeting_automation',
  'targeting_relaxation_types',
  'brand_safety_content_filter_levels',
  'device_platforms',
]);
export function metaTargetingOf(input: unknown): Targeting {
  const targeting = row(input);
  const geo = row(targeting.geo_locations);
  const placements = strings(targeting.instagram_positions);
  const platforms = strings(targeting.publisher_platforms);
  for (const platform of platforms) if (platform !== 'instagram') placements.push(`platform:${platform}`);
  // Regions, cities, exclusions, audiences, behaviours...: rewriting from the config would drop them and widen the
  // audience, so they are reported as unmanaged and block the plan.
  const unmanaged = [
    ...Object.keys(geo)
      .filter((key) => key !== 'countries' && key !== 'location_types')
      .map((key) => `geo_locations.${key}`),
    ...Object.keys(targeting).filter((key) => !META_MODELLED_TARGETING.has(key)),
  ];
  if (Array.isArray(targeting.flexible_spec))
    for (const spec of targeting.flexible_spec)
      for (const key of Object.keys(row(spec))) if (key !== 'interests') unmanaged.push(`flexible_spec.${key}`);
  const interests = [
    ...(Array.isArray(targeting.interests) ? targeting.interests : []),
    ...(Array.isArray(targeting.flexible_spec)
      ? targeting.flexible_spec.flatMap((spec) =>
          Array.isArray(row(spec).interests) ? (row(spec).interests as unknown[]) : [],
        )
      : []),
  ].map((interest) => str(row(interest).id));
  return {
    countries: strings(geo.countries),
    placements,
    interests: interests.filter(Boolean),
    communities: [],
    ageMin: typeof targeting.age_min === 'number' ? targeting.age_min : null,
    ageMax: typeof targeting.age_max === 'number' ? targeting.age_max : null,
    unmanaged,
  };
}
export function metaTargetingBody(targeting: Targeting): Row {
  return {
    geo_locations: { countries: targeting.countries },
    ...(targeting.ageMin !== null ? { age_min: targeting.ageMin } : {}),
    ...(targeting.ageMax !== null ? { age_max: targeting.ageMax } : {}),
    publisher_platforms: ['instagram'],
    instagram_positions: targeting.placements,
    ...(targeting.interests.length
      ? { flexible_spec: [{ interests: targeting.interests.map((id) => ({ id })) }] }
      : {}),
    targeting_automation: { advantage_audience: 0 },
  };
}
function destinationOf(creative: Row): string | null {
  const story = row(creative.object_story_spec);
  const link = str(row(story.link_data).link) || str(row(row(row(story.video_data).call_to_action).value).link);
  if (!link) return null;
  const tags = str(creative.url_tags);
  return tags ? `${link}${link.includes('?') ? '&' : '?'}${tags}` : link;
}

export function createMetaAdsClient(
  config: PaidSocialConfig,
  accessToken: string,
  fetchImpl: FetchLike = fetch,
  sleep?: (milliseconds: number) => Promise<void>,
): PaidSocialClient {
  if (config.platform !== 'meta') throw new Error('Meta client needs a Meta config');
  const secrets = [accessToken];
  if (!config.adAccountId) throw new Error('Set adAccountId in the Meta config before a live action');
  const account = `act_${encodeURIComponent(config.adAccountId)}`;
  const headers = { Authorization: `Bearer ${accessToken}` };

  async function get(path: string, label: string, fields: string): Promise<Row> {
    return requestJson(
      fetchImpl,
      `${META_GRAPH_BASE}/${path}?${new URLSearchParams({ fields })}`,
      { method: 'GET', headers },
      {
        label: `Meta ${label}`,
        read: true,
        secrets,
        sleep,
      },
    );
  }
  async function post(path: string, label: string, body: Row): Promise<Row> {
    return requestJson(
      fetchImpl,
      `${META_GRAPH_BASE}/${path}`,
      { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      { label: `Meta ${label}`, read: false, secrets, sleep },
    );
  }
  async function list(path: string, label: string, fields: string): Promise<Row[]> {
    const rows: Row[] = [];
    let url: string | null = `${META_GRAPH_BASE}/${path}?${new URLSearchParams({ fields, limit: '200' })}`;
    for (let page = 0; url; page++) {
      if (page >= 50) throw new Error(`Meta ${label} pagination exceeded 50 pages`);
      const body: Row = await requestJson(
        fetchImpl,
        url,
        { method: 'GET', headers },
        { label: `Meta ${label}`, read: true, secrets, sleep },
      );
      if (!Array.isArray(body.data)) throw new Error(`Meta ${label} returned no data list`);
      rows.push(...(body.data as Row[]));
      const next = row(body.paging).next;
      url = typeof next === 'string' && next ? assertSameOrigin(next, META_GRAPH_ORIGIN) : null;
    }
    return rows;
  }
  function createdId(body: Row, label: string): string {
    const id = str(body.id);
    if (!id) throw new Error(`Meta ${label} returned no id; rerun plan before retrying`);
    return id;
  }

  return {
    platform: 'meta',
    async account() {
      const body = await get(account, 'ad account read', 'account_id,currency');
      return { id: str(body.account_id), currency: str(body.currency) };
    },
    async listCampaigns(): Promise<LiveCampaign[]> {
      return (
        await list(`${account}/campaigns`, 'campaign list', 'id,name,status,objective,daily_budget,lifetime_budget')
      ).map((campaign) => ({
        id: str(campaign.id),
        name: str(campaign.name),
        status: str(campaign.status),
        objective: str(campaign.objective),
        dailyBudgetCents: minorToCents(campaign.daily_budget),
        lifetimeBudget: minorToCents(campaign.lifetime_budget) !== null,
      }));
    },
    async listAdGroups(campaignId): Promise<LiveAdGroup[]> {
      return (
        await list(
          `${encodeURIComponent(campaignId)}/adsets`,
          'ad set list',
          'id,name,status,campaign_id,daily_budget,lifetime_budget,end_time,targeting',
        )
      ).map((adSet) => ({
        id: str(adSet.id),
        name: str(adSet.name),
        campaignId: str(adSet.campaign_id),
        status: str(adSet.status),
        dailyBudgetCents: minorToCents(adSet.daily_budget),
        lifetimeBudget: minorToCents(adSet.lifetime_budget) !== null,
        endDate: dateOf(adSet.end_time),
        targeting: metaTargetingOf(adSet.targeting),
      }));
    },
    async listAds(adGroupId): Promise<LiveAd[]> {
      return (
        await list(
          `${encodeURIComponent(adGroupId)}/ads`,
          'ad list',
          'id,name,status,adset_id,creative{id,name,url_tags,object_story_spec}',
        )
      ).map((ad) => {
        const creative = row(ad.creative);
        return {
          id: str(ad.id),
          name: str(ad.name),
          adGroupId: str(ad.adset_id),
          status: str(ad.status),
          destination: destinationOf(creative),
          creativeId: str(creative.id) || null,
          creativeName: str(creative.name) || null,
        };
      });
    },
    async createCampaign(spec: CampaignWrite) {
      const body = await post(`${account}/campaigns`, 'campaign create', {
        name: spec.name,
        objective: spec.objective,
        status: 'PAUSED',
        special_ad_categories: [],
        buying_type: 'AUCTION',
        ...(spec.dailyBudgetCents === null
          ? { is_adset_budget_sharing_enabled: false }
          : { daily_budget: spec.dailyBudgetCents, bid_strategy: 'LOWEST_COST_WITHOUT_CAP' }),
      });
      return createdId(body, 'campaign create');
    },
    async updateCampaign(id, patch: CampaignPatch) {
      await post(encodeURIComponent(id), 'campaign update', {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.dailyBudgetCents !== undefined ? { daily_budget: patch.dailyBudgetCents } : {}),
      });
    },
    async createAdGroup(campaignId, spec: AdGroupWrite) {
      const body = await post(`${account}/adsets`, 'ad set create', {
        name: spec.name,
        campaign_id: campaignId,
        status: 'PAUSED',
        billing_event: 'IMPRESSIONS',
        optimization_goal: 'LINK_CLICKS',
        destination_type: 'WEBSITE',
        ...(spec.dailyBudgetCents === null
          ? {}
          : { daily_budget: spec.dailyBudgetCents, bid_strategy: 'LOWEST_COST_WITHOUT_CAP' }),
        start_time: spec.startTime,
        ...(spec.endTime !== null ? { end_time: spec.endTime } : {}),
        targeting: metaTargetingBody(spec.targeting),
      });
      return createdId(body, 'ad set create');
    },
    async updateAdGroup(id, patch: AdGroupPatch) {
      if (patch.endTime === null) throw new Error('Clearing an ad set end date is not supported');
      await post(encodeURIComponent(id), 'ad set update', {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.dailyBudgetCents !== undefined ? { daily_budget: patch.dailyBudgetCents } : {}),
        ...(patch.endTime !== undefined ? { end_time: patch.endTime } : {}),
        ...(patch.targeting !== undefined ? { targeting: metaTargetingBody(patch.targeting) } : {}),
      });
    },
    async createCreative(spec: CreativeWrite) {
      const upload = await post(`${account}/adimages`, 'image upload', {
        bytes: Buffer.from(spec.image).toString('base64'),
        name: spec.imageName,
      });
      const images = Object.values(row(upload.images));
      const imageHash = str(row(images[0]).hash);
      if (images.length !== 1 || !imageHash) throw new Error('Meta image upload returned no hash');
      const body = await post(`${account}/adcreatives`, 'creative create', {
        name: spec.name,
        object_story_spec: {
          page_id: spec.pageId,
          instagram_user_id: spec.instagramUserId,
          link_data: {
            link: spec.link,
            message: spec.body,
            name: spec.headline,
            image_hash: imageHash,
            call_to_action: { type: spec.callToAction, value: { link: spec.link } },
          },
        },
        url_tags: spec.urlTags,
      });
      return createdId(body, 'creative create');
    },
    async createAd(adGroupId, spec: AdWrite) {
      const body = await post(`${account}/ads`, 'ad create', {
        name: spec.name,
        adset_id: adGroupId,
        creative: { creative_id: spec.creativeId },
        status: 'PAUSED',
      });
      return createdId(body, 'ad create');
    },
    async updateAd(id, patch: AdPatch) {
      if (patch.destination !== undefined) throw new Error('Meta ads take their destination from the creative');
      await post(encodeURIComponent(id), 'ad update', {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.creativeId !== undefined ? { creative: { creative_id: patch.creativeId } } : {}),
      });
    },
  };
}
