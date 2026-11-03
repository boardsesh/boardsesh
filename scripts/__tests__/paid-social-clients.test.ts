import { describe, expect, it } from 'vite-plus/test';
import { createMetaAdsClient, metaTargetingOf, metaTokenFromEnv } from '../lib/meta-ads-client';
import type { PaidSocialConfig } from '../lib/paid-social';
import { redact } from '../lib/paid-social-http';
import { createRedditAdsClient, redditCredentialsFromEnv } from '../lib/reddit-ads-client';
import { redditConfig } from './helpers/fake-paid-social';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}
type Route = (request: Recorded) => { status?: number; json: unknown } | undefined;

function fakeFetch(routes: Route[]) {
  const requests: Recorded[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    const request: Recorded = {
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? init.body : undefined,
    };
    requests.push(request);
    for (const route of routes) {
      const response = route(request);
      if (response) return new Response(JSON.stringify(response.json), { status: response.status ?? 200 });
    }
    return new Response(JSON.stringify({ error: { message: `no route for ${request.method} ${url}` } }), {
      status: 404,
    });
  };
  return { fetchImpl, requests };
}
const noSleep = async () => {};

const SECRETS = { clientId: 'client-id-123', clientSecret: 'client-secret-456', refreshToken: 'refresh-token-789' };
const tokenRoute: Route = (request) =>
  request.url === 'https://www.reddit.com/api/v1/access_token'
    ? { json: { access_token: 'access-token-abc' } }
    : undefined;

describe('Reddit client', () => {
  it('refreshes once with basic auth and sends the token only as a header', async () => {
    const { fetchImpl, requests } = fakeFetch([
      tokenRoute,
      (request) =>
        request.url.includes('/ad_accounts/acct1') && !request.url.includes('campaigns')
          ? { json: { data: { id: 'acct1', currency: 'AUD' } } }
          : undefined,
      (request) => (request.url.includes('/campaigns') ? { json: { data: [], pagination: {} } } : undefined),
    ]);
    const client = createRedditAdsClient(redditConfig(), SECRETS, fetchImpl, noSleep);
    expect(await client.account()).toEqual({ id: 'acct1', currency: 'AUD' });
    await client.listCampaigns();
    const tokenCalls = requests.filter((request) => request.url.includes('access_token'));
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0].headers.Authorization).toBe(
      `Basic ${Buffer.from('client-id-123:client-secret-456').toString('base64')}`,
    );
    expect(tokenCalls[0].body).toBe('grant_type=refresh_token&refresh_token=refresh-token-789');
    for (const request of requests.slice(1)) {
      expect(request.headers.Authorization).toBe('Bearer access-token-abc');
      expect(request.url).not.toMatch(/token|secret/);
    }
  });

  it('follows pagination on the API host only and maps budgets from micros', async () => {
    const { fetchImpl } = fakeFetch([
      tokenRoute,
      (request) =>
        request.url.includes('page.token=2')
          ? {
              json: {
                data: [
                  {
                    id: 'c2',
                    name: 'B',
                    configured_status: 'PAUSED',
                    objective: 'CLICKS',
                    goal_type: 'LIFETIME_SPEND',
                    goal_value: 5_000_000,
                  },
                ],
                pagination: {},
              },
            }
          : undefined,
      (request) =>
        request.url.includes('/campaigns')
          ? {
              json: {
                data: [
                  {
                    id: 'c1',
                    name: 'A',
                    configured_status: 'ACTIVE',
                    objective: 'CLICKS',
                    is_campaign_budget_optimization: true,
                    goal_type: 'DAILY_SPEND',
                    goal_value: 12_340_000,
                  },
                ],
                pagination: { next_url: 'https://ads-api.reddit.com/api/v3/ad_accounts/acct1/campaigns?page.token=2' },
              },
            }
          : undefined,
    ]);
    const campaigns = await createRedditAdsClient(redditConfig(), SECRETS, fetchImpl, noSleep).listCampaigns();
    expect(campaigns).toEqual([
      { id: 'c1', name: 'A', status: 'ACTIVE', objective: 'CLICKS', dailyBudgetCents: 1234, lifetimeBudget: false },
      { id: 'c2', name: 'B', status: 'PAUSED', objective: 'CLICKS', dailyBudgetCents: null, lifetimeBudget: true },
    ]);
  });

  it('refuses a pagination link to another host', async () => {
    const { fetchImpl } = fakeFetch([
      tokenRoute,
      () => ({ json: { data: [], pagination: { next_url: 'https://evil.example/steal' } } }),
    ]);
    await expect(createRedditAdsClient(redditConfig(), SECRETS, fetchImpl, noSleep).listCampaigns()).rejects.toThrow(
      /Refusing to follow/,
    );
  });

  it('creates ad groups and ads PAUSED with the pixel, micros and the built click URL', async () => {
    const { fetchImpl, requests } = fakeFetch([
      tokenRoute,
      (request) => (request.method === 'POST' ? { json: { data: { id: 'new-1' } } } : undefined),
    ]);
    const client = createRedditAdsClient(redditConfig(), SECRETS, fetchImpl, noSleep);
    await client.createAdGroup('c1', {
      name: 'homewalls',
      dailyBudgetCents: 1000,
      startTime: '2026-11-03T00:00:00.000Z',
      endTime: '2026-11-30T23:59:00Z',
      targeting: {
        countries: ['US'],
        placements: ['FEED'],
        interests: [],
        communities: ['climbing'],
        ageMin: null,
        ageMax: null,
      },
    });
    await client.createAd('new-1', {
      name: 'homewalls-ad-1',
      status: 'ACTIVE',
      destination: 'https://www.boardsesh.com/?x',
      creativeId: 't3_abc',
    });
    const writes = requests.filter((request) => request.method === 'POST' && !request.url.includes('access_token'));
    expect(JSON.parse(writes[0].body!)).toEqual({
      data: {
        campaign_id: 'c1',
        name: 'homewalls',
        configured_status: 'PAUSED',
        bid_strategy: 'MAXIMIZE_VOLUME',
        bid_type: 'CPC',
        goal_type: 'DAILY_SPEND',
        goal_value: 10_000_000,
        start_time: '2026-11-03T00:00:00.000Z',
        end_time: '2026-11-30T23:59:00Z',
        targeting: { geolocations: ['US'], locations: ['FEED'], interests: [], communities: ['climbing'] },
        conversion_pixel_id: 'a2_pixel',
      },
    });
    expect(JSON.parse(writes[1].body!).data).toEqual({
      ad_group_id: 'new-1',
      name: 'homewalls-ad-1',
      configured_status: 'PAUSED',
      post_id: 't3_abc',
      click_url: 'https://www.boardsesh.com/?x',
    });
  });

  it('patches status and budget on the entity URL', async () => {
    const { fetchImpl, requests } = fakeFetch([
      tokenRoute,
      (request) => (request.method === 'PATCH' ? { json: { data: {} } } : undefined),
    ]);
    const client = createRedditAdsClient(redditConfig(), SECRETS, fetchImpl, noSleep);
    await client.updateAdGroup('g1', { status: 'PAUSED', dailyBudgetCents: 550 });
    const patch = requests.find((request) => request.method === 'PATCH')!;
    expect(patch.url).toBe('https://ads-api.reddit.com/api/v3/ad_groups/g1');
    expect(JSON.parse(patch.body!)).toEqual({
      data: { configured_status: 'PAUSED', goal_type: 'DAILY_SPEND', goal_value: 5_500_000 },
    });
  });

  it('retries reads but never writes, and scrubs secrets from errors', async () => {
    let reads = 0;
    const { fetchImpl, requests } = fakeFetch([
      tokenRoute,
      (request) => {
        if (request.method === 'GET') {
          reads++;
          return reads < 3 ? { status: 503, json: {} } : { json: { data: { id: 'acct1', currency: 'AUD' } } };
        }
        return { status: 500, json: { error: { message: 'bad request with access-token-abc and client-secret-456' } } };
      },
    ]);
    const client = createRedditAdsClient(redditConfig(), SECRETS, fetchImpl, noSleep);
    await expect(client.account()).resolves.toEqual({ id: 'acct1', currency: 'AUD' });
    const failure = await client.updateCampaign('c1', { status: 'PAUSED' }).then(
      () => '',
      (error: Error) => error.message,
    );
    expect(failure).toMatch(/HTTP 500/);
    expect(failure).not.toContain('access-token-abc');
    expect(failure).not.toContain('client-secret-456');
    expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(1);
  });

  it('reports keywords, audiences and expand_targeting as unmanaged targeting', async () => {
    const { fetchImpl } = fakeFetch([
      tokenRoute,
      () => ({
        json: {
          data: [
            {
              id: 'g1',
              name: 'homewalls',
              campaign_id: 'c1',
              configured_status: 'ACTIVE',
              goal_type: 'DAILY_SPEND',
              goal_value: 10_000_000,
              targeting: {
                geolocations: ['US'],
                communities: ['climbing'],
                keywords: ['kilter'],
                excluded_communities: [],
                expand_targeting: true,
                gender: null,
              },
            },
          ],
          pagination: {},
        },
      }),
    ]);
    const [group] = await createRedditAdsClient(redditConfig(), SECRETS, fetchImpl, noSleep).listAdGroups('c1');
    expect(group.targeting.unmanaged).toEqual(['keywords', 'expand_targeting']);
    expect(group.dailyBudgetCents).toBe(1000);
  });

  it('names every missing credential', () => {
    expect(() => redditCredentialsFromEnv({ REDDIT_ADS_CLIENT_ID: 'x' })).toThrow(
      'Missing REDDIT_ADS_CLIENT_SECRET, REDDIT_ADS_REFRESH_TOKEN',
    );
  });

  it('refuses a live action before the account id is set', () => {
    expect(() => createRedditAdsClient(redditConfig({ adAccountId: null }), SECRETS)).toThrow(/Set adAccountId/);
  });
});

const metaConfig: PaidSocialConfig = {
  ...redditConfig(),
  platform: 'meta',
  reddit: undefined,
  meta: { pageId: '111', instagramUserId: '222' },
};
delete metaConfig.reddit;

describe('Meta client', () => {
  const TOKEN = 'meta-system-user-token';

  it('sends the token as a Bearer header and never in a URL', async () => {
    const { fetchImpl, requests } = fakeFetch([
      (request) =>
        request.url.includes('/act_acct1?')
          ? { json: { id: 'act_acct1', account_id: 'acct1', currency: 'AUD' } }
          : undefined,
      () => ({ json: { data: [] } }),
    ]);
    const client = createMetaAdsClient(metaConfig, TOKEN, fetchImpl, noSleep);
    expect(await client.account()).toEqual({ id: 'acct1', currency: 'AUD' });
    await client.listCampaigns();
    for (const request of requests) {
      expect(request.url.startsWith('https://graph.facebook.com/v26.0/')).toBe(true);
      expect(request.url).not.toContain(TOKEN);
      expect(request.url).not.toContain('access_token');
      expect(request.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  it('reads ads with their creative destination and name', async () => {
    const { fetchImpl } = fakeFetch([
      () => ({
        json: {
          data: [
            {
              id: 'a1',
              name: 'homewalls-ad-1',
              status: 'ACTIVE',
              adset_id: 'g1',
              creative: {
                id: 'cr1',
                name: 'Boardsesh Managed homewalls-ad-1 abc',
                url_tags: 'utm_source=instagram&utm_content=homewalls-ad-1',
                object_story_spec: { link_data: { link: 'https://www.boardsesh.com/' } },
              },
            },
          ],
        },
      }),
    ]);
    expect(await createMetaAdsClient(metaConfig, TOKEN, fetchImpl, noSleep).listAds('g1')).toEqual([
      {
        id: 'a1',
        name: 'homewalls-ad-1',
        adGroupId: 'g1',
        status: 'ACTIVE',
        destination: 'https://www.boardsesh.com/?utm_source=instagram&utm_content=homewalls-ad-1',
        creativeId: 'cr1',
        creativeName: 'Boardsesh Managed homewalls-ad-1 abc',
      },
    ]);
  });

  it('flags placements outside Instagram so the plan rewrites them', () => {
    expect(
      metaTargetingOf({
        geo_locations: { countries: ['US'], regions: [{ key: '1' }], location_types: ['home'] },
        publisher_platforms: ['instagram', 'facebook'],
        instagram_positions: ['stream'],
        flexible_spec: [{ interests: [{ id: '6003', name: 'Rock climbing' }] }],
        age_min: 18,
        age_max: 45,
      }),
    ).toEqual({
      countries: ['US'],
      placements: ['stream', 'platform:facebook'],
      interests: ['6003'],
      communities: [],
      ageMin: 18,
      ageMax: 45,
      advantageAudience: false,
      unmanaged: ['geo_locations.regions'],
    });
  });

  it('reports audiences, exclusions and other unmodelled targeting as unmanaged', () => {
    expect(
      metaTargetingOf({
        geo_locations: { countries: ['US'], excluded_countries: ['CA'] },
        custom_audiences: [{ id: '1' }],
        genders: [1],
        flexible_spec: [{ interests: [{ id: '6003' }], behaviors: [{ id: '9' }] }],
        targeting_automation: { advantage_audience: 0 },
      }).unmanaged,
    ).toEqual(['geo_locations.excluded_countries', 'custom_audiences', 'genders', 'flexible_spec.behaviors']);
  });

  it('creates campaigns and ad sets PAUSED with ad-set budgets and Instagram-only targeting', async () => {
    const { fetchImpl, requests } = fakeFetch([() => ({ json: { id: 'new-1' } })]);
    const client = createMetaAdsClient(metaConfig, TOKEN, fetchImpl, noSleep);
    await client.createCampaign({
      name: 'Boardsesh Managed x',
      objective: 'OUTCOME_TRAFFIC',
      dailyBudgetCents: null,
      startTime: '2026-11-03T00:00:00Z',
      endTime: null,
    });
    await client.createAdGroup('new-1', {
      name: 'homewalls',
      dailyBudgetCents: 1000,
      startTime: '2026-11-03T00:00:00Z',
      endTime: null,
      targeting: {
        countries: ['US'],
        placements: ['stream'],
        interests: ['6003'],
        communities: [],
        ageMin: 18,
        ageMax: 65,
      },
    });
    const [campaign, adSet] = requests.map((request) => JSON.parse(request.body!) as Record<string, unknown>);
    expect(campaign).toMatchObject({
      status: 'PAUSED',
      special_ad_categories: [],
      is_adset_budget_sharing_enabled: false,
    });
    expect(campaign).not.toHaveProperty('daily_budget');
    expect(adSet).toMatchObject({
      status: 'PAUSED',
      daily_budget: 1000,
      destination_type: 'WEBSITE',
      targeting: {
        geo_locations: { countries: ['US'] },
        publisher_platforms: ['instagram'],
        instagram_positions: ['stream'],
        flexible_spec: [{ interests: [{ id: '6003' }] }],
      },
    });
    expect(adSet).not.toHaveProperty('end_time');
  });

  it('uploads the image, then builds the creative with url_tags and the Instagram account', async () => {
    const { fetchImpl, requests } = fakeFetch([
      (request) =>
        request.url.endsWith('/adimages') ? { json: { images: { 'homewall.jpg': { hash: 'h1' } } } } : undefined,
      () => ({ json: { id: 'cr-new' } }),
    ]);
    const id = await createMetaAdsClient(metaConfig, TOKEN, fetchImpl, noSleep).createCreative({
      name: 'Boardsesh Managed homewalls-ad-1 abc',
      image: new Uint8Array([1, 2]),
      imageName: 'homewall.jpg',
      headline: 'Head',
      body: 'Body',
      callToAction: 'LEARN_MORE',
      link: 'https://www.boardsesh.com/',
      urlTags: 'utm_source=instagram&utm_medium=paid-social&utm_campaign=nov26-launch&utm_content=homewalls-ad-1',
      pageId: '111',
      instagramUserId: '222',
    });
    expect(id).toBe('cr-new');
    expect(JSON.parse(requests[0].body!)).toEqual({ bytes: 'AQI=', name: 'homewall.jpg' });
    expect(JSON.parse(requests[1].body!)).toEqual({
      name: 'Boardsesh Managed homewalls-ad-1 abc',
      object_story_spec: {
        page_id: '111',
        instagram_user_id: '222',
        link_data: {
          link: 'https://www.boardsesh.com/',
          message: 'Body',
          name: 'Head',
          image_hash: 'h1',
          call_to_action: { type: 'LEARN_MORE', value: { link: 'https://www.boardsesh.com/' } },
        },
      },
      url_tags: 'utm_source=instagram&utm_medium=paid-social&utm_campaign=nov26-launch&utm_content=homewalls-ad-1',
    });
  });

  it('refuses to set a destination on a Meta ad and to clear an end date', async () => {
    const client = createMetaAdsClient(metaConfig, TOKEN, fakeFetch([]).fetchImpl, noSleep);
    await expect(client.updateAd('a1', { destination: 'https://x' })).rejects.toThrow(/from the creative/);
    await expect(client.updateAdGroup('g1', { endTime: null })).rejects.toThrow(/not supported/);
  });

  it('scrubs the token from Graph errors', async () => {
    const { fetchImpl } = fakeFetch([
      () => ({
        status: 400,
        json: { error: { code: 190, type: 'OAuthException', message: `Invalid token ${TOKEN}` } },
      }),
    ]);
    const message = await createMetaAdsClient(metaConfig, TOKEN, fetchImpl, noSleep)
      .updateCampaign('c1', { status: 'PAUSED' })
      .then(
        () => '',
        (error: Error) => error.message,
      );
    expect(message).toBe(
      'Meta campaign update failed (HTTP 400): 190 OAuthException Invalid token [redacted]; rerun plan to see what landed',
    );
  });

  it('requires the access token', () => {
    expect(() => metaTokenFromEnv({})).toThrow('Missing META_ADS_ACCESS_TOKEN');
  });
});

describe('redact', () => {
  it('removes token-shaped text even when the secret is unknown', () => {
    expect(redact('url?access_token=abc123&x=1 Bearer zzz.yyy', [])).toBe(
      'url?access_token=[redacted]&x=1 Bearer [redacted]',
    );
  });
});
