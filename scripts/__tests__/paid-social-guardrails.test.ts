/** Spend-safety cases found in the adversarial review of the ads-as-code PR. */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { buildPlan, validateConfig, type PaidSocialConfig, type PlanOptions } from '../lib/paid-social';
import { main } from '../paid-social-ads';
import { emptyAccount, fakeClient, liveTargeting, redditConfig, type FakeAccount } from './helpers/fake-paid-social';

const options: PlanOptions = {
  readCreativeFile: async () => new Uint8Array([1]),
  now: () => new Date('2026-11-03T00:00:00Z'),
};

function activeConfig(): PaidSocialConfig {
  const config = redditConfig();
  config.campaigns[0].status = 'ACTIVE';
  config.campaigns[0].adGroups[0].status = 'ACTIVE';
  config.campaigns[0].adGroups[0].ads[0].status = 'ACTIVE';
  return config;
}
function liveManaged(state: FakeAccount, status = 'ACTIVE') {
  state.campaigns.push({
    id: 'c1',
    name: 'Boardsesh Managed nov26-launch',
    status,
    objective: 'CLICKS',
    dailyBudgetCents: null,
    lifetimeBudget: false,
  });
  state.adGroups.push({
    id: 'g1',
    name: 'homewalls',
    campaignId: 'c1',
    status,
    dailyBudgetCents: 1000,
    lifetimeBudget: false,
    endDate: '2026-11-30',
    targeting: liveTargeting(),
  });
  state.ads.push({
    id: 'a1',
    name: 'homewalls-ad-1',
    adGroupId: 'g1',
    status,
    destination:
      'https://www.boardsesh.com/?utm_source=reddit&utm_medium=paid-social&utm_campaign=nov26-launch&utm_content=homewalls-ad-1',
    creativeId: 't3_abc123',
    creativeName: null,
  });
}

describe('live spend baseline', () => {
  it('counts an active ad group with no active ad as zero spend', async () => {
    const state = emptyAccount();
    liveManaged(state);
    state.ads[0].status = 'PAUSED';
    const plan = await buildPlan(activeConfig(), fakeClient('reddit', state), options);
    expect(plan.liveActiveCents).toBe(0);
    expect(plan.blocked.join('\n')).toMatch(/0.00 -> 10.00/);
  });

  it('counts an ended ad group as zero spend, so extending it is a jump', async () => {
    const state = emptyAccount();
    liveManaged(state);
    state.adGroups[0].endDate = '2026-10-31';
    const plan = await buildPlan(activeConfig(), fakeClient('reddit', state), options);
    expect(plan.liveActiveCents).toBe(0);
    expect(plan.blocked.join('\n')).toMatch(/0.00 -> 10.00/);
  });

  it('counts a running ad group at its budget', async () => {
    const state = emptyAccount();
    liveManaged(state);
    const plan = await buildPlan(activeConfig(), fakeClient('reddit', state), options);
    expect(plan.liveActiveCents).toBe(1000);
    expect(plan.blocked).toEqual([]);
  });
});

describe('duplicates and orphans', () => {
  it('refuses to create a campaign while an unmanaged live campaign carries its code', async () => {
    const state = emptyAccount();
    state.campaigns.push({
      id: 'live-1',
      name: 'Reddit nov26-launch homewalls',
      status: 'ACTIVE',
      objective: 'CLICKS',
      dailyBudgetCents: null,
      lifetimeBudget: false,
    });
    const plan = await buildPlan(redditConfig(), fakeClient('reddit', state), options);
    expect(plan.blocked[0]).toMatch(/live campaign live-1 already carries this code; adopt it/);
    expect(plan.operations).toEqual([]);
  });

  it('pins the namespace so a rename cannot orphan managed campaigns', () => {
    expect(() => validateConfig(redditConfig({ namespace: 'Boardsesh Ads' }))).toThrow(
      /namespace must be "Boardsesh Managed"/,
    );
  });
});

describe('targeting and creatives', () => {
  it('blocks a plan that would drop live targeting the config cannot express', async () => {
    const state = emptyAccount();
    liveManaged(state, 'PAUSED');
    state.adGroups[0].targeting = { ...liveTargeting(), unmanaged: ['keywords'] };
    const plan = await buildPlan(redditConfig(), fakeClient('reddit', state), options);
    expect(plan.blocked.join('\n')).toMatch(/live targeting uses keywords/);
  });

  it('never switches on an ad whose configured creative is still pending', async () => {
    const config: PaidSocialConfig = {
      ...redditConfig(),
      platform: 'meta',
      meta: { pageId: null, instagramUserId: null },
      allowBudgetJump: true,
    };
    delete config.reddit;
    config.campaigns[0].objective = 'OUTCOME_TRAFFIC';
    config.campaigns[0].adGroups[0].targeting = { countries: ['US'], placements: ['stream'], interests: [] };
    config.campaigns[0].adGroups[0].ads[0] = {
      name: 'homewalls-ad-1',
      status: 'ACTIVE',
      creative: {
        image: 'app-stores/paid-social/creatives/a.jpg',
        headline: 'H',
        body: 'B',
        callToAction: 'LEARN_MORE',
      },
    };
    const state = emptyAccount();
    liveManaged(state, 'PAUSED');
    state.campaigns[0].objective = 'OUTCOME_TRAFFIC';
    state.adGroups[0].targeting = {
      countries: ['US'],
      placements: ['stream'],
      interests: [],
      communities: [],
      ageMin: 18,
      ageMax: 65,
    };
    const plan = await buildPlan(validateConfig(config, 'meta'), fakeClient('meta', state), options);
    expect(plan.pending[0]).toMatch(/meta.pageId/);
    expect(plan.operations.some((operation) => operation.kind === 'ad')).toBe(false);
  });
});

describe('out-of-repo spend ceiling', () => {
  function metaConfigWithAccount() {
    const path = join(mkdtempSync(join(tmpdir(), 'ads-ceiling-')), 'ads.json');
    const config = JSON.parse(readFileSync('app-stores/meta/ads.json', 'utf8')) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...config, adAccountId: 'acct1' }));
    return path;
  }
  function dependencies(env: NodeJS.ProcessEnv) {
    const fetched: string[] = [];
    return {
      fetched,
      deps: {
        env,
        fetch: async (url: string) => {
          fetched.push(url);
          return new Response('{}', { status: 500 });
        },
        now: () => new Date('2026-11-03T00:00:00Z'),
        stdout: () => {},
      },
    };
  }

  it('refuses an apply without PAID_SOCIAL_MAX_DAILY, before any request', async () => {
    const { deps, fetched } = dependencies({ META_ADS_ACCESS_TOKEN: 'token' });
    await expect(
      main(['--platform', 'meta', '--action', 'apply', '--config', metaConfigWithAccount()], deps),
    ).rejects.toThrow(/Missing PAID_SOCIAL_MAX_DAILY/);
    expect(fetched).toEqual([]);
  });

  it('refuses a config cap above the ceiling, even for a plan', async () => {
    const { deps, fetched } = dependencies({ META_ADS_ACCESS_TOKEN: 'token', PAID_SOCIAL_MAX_DAILY: '15.00' });
    await expect(main(['--platform', 'meta', '--config', metaConfigWithAccount()], deps)).rejects.toThrow(
      /above the Production ceiling PAID_SOCIAL_MAX_DAILY 15.00/,
    );
    expect(fetched).toEqual([]);
  });
});
