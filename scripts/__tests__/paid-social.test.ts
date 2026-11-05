import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import {
  buildPlan,
  executePlan,
  fileCreativeName,
  offlinePlan,
  planGuardrails,
  reconcile,
  toCents,
  validateConfig,
  type Operation,
  type PaidSocialConfig,
  type PlanOptions,
} from '../lib/paid-social';
import { emptyAccount, fakeClient, liveTargeting, redditConfig, type FakeAccount } from './helpers/fake-paid-social';

const IMAGE = new Uint8Array([1, 2, 3, 4]);
const options: PlanOptions = {
  readCreativeFile: async () => IMAGE,
  now: () => new Date('2026-11-03T00:00:00Z'),
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function withChanges(change: (config: PaidSocialConfig) => void, base = redditConfig()): PaidSocialConfig {
  const config = clone(base);
  change(config);
  return config;
}
function activeConfig(overrides: Partial<PaidSocialConfig> = {}) {
  return withChanges((config) => {
    config.campaigns[0].status = 'ACTIVE';
    config.campaigns[0].adGroups[0].status = 'ACTIVE';
    config.campaigns[0].adGroups[0].ads[0].status = 'ACTIVE';
    Object.assign(config, overrides);
  });
}
/** A managed live campaign mirroring redditConfig(), with the given statuses and budget. */
function liveManaged(state: FakeAccount, status = 'PAUSED', budgetCents = 1000) {
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
    dailyBudgetCents: budgetCents,
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
function writesTo(state: FakeAccount, id: string) {
  return state.calls.filter((call) => call.id === id);
}

describe('validateConfig', () => {
  it('accepts both seeded configs, which start nothing', () => {
    for (const platform of ['meta', 'reddit'] as const) {
      const config = validateConfig(JSON.parse(readFileSync(`app-stores/${platform}/ads.json`, 'utf8')), platform);
      expect(config.campaigns.every((campaign) => campaign.status === 'ADOPT_PENDING')).toBe(true);
      expect(config.allowBudgetJump).toBe(false);
      expect(config.adoptCampaignIds).toEqual([]);
    }
  });

  it('seeded configs build exactly the live destination URLs', async () => {
    const reddit = validateConfig(JSON.parse(readFileSync('app-stores/reddit/ads.json', 'utf8')), 'reddit');
    const meta = validateConfig(JSON.parse(readFileSync('app-stores/meta/ads.json', 'utf8')), 'meta');
    const readNothing = async () => IMAGE;
    const redditPlan = JSON.stringify(await offlinePlan(reddit, readNothing));
    const metaPlan = JSON.stringify(await offlinePlan(meta, readNothing));
    expect(redditPlan).toContain(
      '"destination":"https://www.boardsesh.com/?utm_source=reddit&utm_medium=paid-social&utm_campaign=nov26-launch&utm_content=homewalls-ad-1"',
    );
    expect(metaPlan).toContain(
      '"destination":"https://www.boardsesh.com/?utm_source=instagram&utm_medium=paid-social&utm_campaign=nov26-launch&utm_content=ig-boost-1"',
    );
  });

  it('refuses a config for the other platform', () => {
    expect(() => validateConfig(redditConfig(), 'meta')).toThrow(/is for reddit/);
  });

  it('refuses active budgets that sum above the cap', () => {
    const config = withChanges((draft) => {
      draft.maxDailyBudgetTotal = '15.00';
      draft.campaigns[0].status = 'ACTIVE';
      draft.campaigns[0].adGroups[0].status = 'ACTIVE';
      draft.campaigns[0].adGroups.push({
        ...clone(draft.campaigns[0].adGroups[0]),
        name: 'spray',
        ads: [{ name: 'spray-1', status: 'ACTIVE', creative: { postId: 't3_x' } }],
      });
    });
    expect(() => validateConfig(config)).toThrow(/above maxDailyBudgetTotal 15.00/);
  });

  it('does not count paused or adopt-pending budgets toward the cap', () => {
    const config = withChanges((draft) => {
      draft.maxDailyBudgetTotal = '15.00';
      draft.campaigns[0].adGroups.push({
        ...clone(draft.campaigns[0].adGroups[0]),
        name: 'spray',
        ads: [{ name: 'spray-1', status: 'PAUSED', creative: { postId: 't3_x' } }],
      });
    });
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('refuses a single budget above the cap even when paused', () => {
    expect(() =>
      validateConfig(withChanges((draft) => (draft.campaigns[0].adGroups[0].dailyBudget = '60.00'))),
    ).toThrow(/above maxDailyBudgetTotal/);
  });

  it('refuses lifetime budgets', () => {
    const config = withChanges((draft) => {
      (draft.campaigns[0].adGroups[0] as unknown as Record<string, unknown>).lifetimeBudget = '100.00';
    });
    expect(() => validateConfig(config)).toThrow(/lifetime budgets are refused/);
  });

  it('refuses an unbounded ad group with no daily budget at either level', () => {
    expect(() => validateConfig(withChanges((draft) => delete draft.campaigns[0].adGroups[0].dailyBudget))).toThrow(
      /unbounded budgets are refused/,
    );
  });

  it('refuses budgets at both levels', () => {
    expect(() => validateConfig(withChanges((draft) => (draft.campaigns[0].dailyBudget = '10.00')))).toThrow(
      /set one level only/,
    );
  });

  it.each(['0', '0.00', '-1', '10.001', '1e3', 10])('refuses budget %j', (budget) => {
    expect(() =>
      validateConfig(
        withChanges(
          (draft) => ((draft.campaigns[0].adGroups[0] as unknown as Record<string, unknown>).dailyBudget = budget),
        ),
      ),
    ).toThrow();
  });

  it('refuses a campaign code longer than 18 characters', () => {
    expect(() => validateConfig(withChanges((draft) => (draft.campaigns[0].code = 'nov26-launch-extra1')))).toThrow(
      /1-18/,
    );
  });

  it('refuses a non-boolean allowBudgetJump', () => {
    expect(() =>
      validateConfig(withChanges((draft) => ((draft as unknown as Record<string, unknown>).allowBudgetJump = 'yes'))),
    ).toThrow(/allowBudgetJump/);
  });

  it('refuses adopting an ADOPT_PENDING campaign or an unknown code', () => {
    expect(() =>
      validateConfig(
        withChanges((draft) => {
          draft.campaigns[0].status = 'ADOPT_PENDING';
          draft.adoptCampaignIds = [{ id: '123', code: 'nov26-launch' }];
        }),
      ),
    ).toThrow(/set its status/);
    expect(() =>
      validateConfig(withChanges((draft) => (draft.adoptCampaignIds = [{ id: '123', code: 'other' }]))),
    ).toThrow(/does not name a configured campaign/);
  });

  it('refuses Meta-only targeting on Reddit and creatives outside the creatives folder', () => {
    expect(() =>
      validateConfig(withChanges((draft) => (draft.campaigns[0].adGroups[0].targeting.ageMin = 18))),
    ).toThrow(/unsupported field/);
    const meta = validateConfig(JSON.parse(readFileSync('app-stores/meta/ads.json', 'utf8')), 'meta');
    const outside = withChanges((draft) => {
      draft.campaigns[0].adGroups[0].ads[0].creative = {
        image: 'app-stores/paid-social/creatives/../../secrets.png',
        headline: 'Find your board',
        body: 'Body',
        callToAction: 'LEARN_MORE',
      };
    }, meta);
    expect(() => validateConfig(outside)).toThrow(/under app-stores\/paid-social\/creatives/);
  });

  it('refuses statuses that would delete or archive', () => {
    expect(() =>
      validateConfig(
        withChanges((draft) => ((draft.campaigns[0] as unknown as Record<string, unknown>).status = 'DELETED')),
      ),
    ).toThrow(/status/);
  });
});

describe('buildPlan', () => {
  it('creates a new campaign tree PAUSED and activates nothing when the config is paused', async () => {
    const state = emptyAccount();
    const plan = await buildPlan(redditConfig(), fakeClient('reddit', state), options);
    expect(plan.operations.map((operation) => `${operation.kind}:${operation.action}`)).toEqual([
      'campaign:create',
      'adGroup:create',
      'ad:create',
    ]);
    expect(plan.blocked).toEqual([]);
    expect(state.calls).toEqual([]);
  });

  it('activates children before parents, and only as the last step', async () => {
    const plan = await buildPlan(
      activeConfig({ allowBudgetJump: true }),
      fakeClient('reddit', emptyAccount()),
      options,
    );
    const order = plan.operations.map((operation) =>
      operation.action === 'update'
        ? `${operation.kind}:${String(operation.patch.status)}`
        : `${operation.kind}:create`,
    );
    expect(order).toEqual([
      'campaign:create',
      'adGroup:create',
      'ad:create',
      'ad:ACTIVE',
      'adGroup:ACTIVE',
      'campaign:ACTIVE',
    ]);
  });

  it('never touches campaigns outside the namespace', async () => {
    const state = emptyAccount();
    state.campaigns.push({
      id: 'foreign',
      name: 'Marco test',
      status: 'ACTIVE',
      objective: 'CLICKS',
      dailyBudgetCents: null,
      lifetimeBudget: false,
    });
    state.adGroups.push({
      id: 'fg',
      name: 'x',
      campaignId: 'foreign',
      status: 'ACTIVE',
      dailyBudgetCents: 99_00,
      lifetimeBudget: false,
      endDate: null,
      targeting: liveTargeting(),
    });
    liveManaged(state);
    const report = await reconcile(redditConfig(), fakeClient('reddit', state), 'apply', options);
    expect(writesTo(state, 'foreign')).toEqual([]);
    expect(writesTo(state, 'fg')).toEqual([]);
    expect(report.liveActiveDailyBudget).toBe('0.00');
    expect(report.readbackMismatches).toEqual([]);
  });

  it('pauses, never deletes, a managed campaign that left the config', async () => {
    const state = emptyAccount();
    liveManaged(state);
    state.campaigns.push({
      id: 'old',
      name: 'Boardsesh Managed oct26-test',
      status: 'ACTIVE',
      objective: 'CLICKS',
      dailyBudgetCents: null,
      lifetimeBudget: false,
    });
    const plan = await buildPlan(redditConfig(), fakeClient('reddit', state), options);
    expect(plan.operations).toEqual([
      expect.objectContaining({
        kind: 'campaign',
        action: 'update',
        target: { id: 'old' },
        patch: { status: 'PAUSED' },
        phase: 1,
      }),
    ]);
  });

  it('pauses live ad groups and ads that left a managed campaign', async () => {
    const state = emptyAccount();
    liveManaged(state, 'ACTIVE');
    state.adGroups.push({
      id: 'g2',
      name: 'old-group',
      campaignId: 'c1',
      status: 'ACTIVE',
      dailyBudgetCents: 500,
      lifetimeBudget: false,
      endDate: null,
      targeting: liveTargeting(),
    });
    state.ads.push({
      id: 'a2',
      name: 'old-ad',
      adGroupId: 'g1',
      status: 'ACTIVE',
      destination: null,
      creativeId: 't3_old',
      creativeName: null,
    });
    const config = activeConfig();
    const plan = await buildPlan(config, fakeClient('reddit', state), options);
    const pauses = plan.operations.filter(
      (operation) => operation.action === 'update' && operation.patch.status === 'PAUSED',
    );
    expect(pauses.map((operation) => ('target' in operation ? operation.target : null))).toEqual([
      { id: 'g2' },
      { id: 'a2' },
    ]);
    expect(pauses.every((operation) => operation.phase === 1)).toBe(true);
  });

  it('adopts a live campaign by id: renames it instead of creating a duplicate', async () => {
    const state = emptyAccount();
    liveManaged(state);
    state.campaigns[0] = { ...state.campaigns[0], id: 'live-1', name: 'Reddit launch Nov' };
    state.adGroups[0].campaignId = 'live-1';
    const config = redditConfig({ adoptCampaignIds: [{ id: 'live-1', code: 'nov26-launch' }] });
    const plan = await buildPlan(config, fakeClient('reddit', state), options);
    expect(plan.operations).toEqual([
      expect.objectContaining({
        kind: 'campaign',
        action: 'update',
        target: { id: 'live-1' },
        patch: { name: 'Boardsesh Managed nov26-launch' },
      }),
    ]);
  });

  it('without an adopt entry a live campaign is foreign and left alone', async () => {
    const state = emptyAccount();
    state.campaigns.push({
      id: 'live-1',
      name: 'Reddit launch Nov',
      status: 'ACTIVE',
      objective: 'CLICKS',
      dailyBudgetCents: null,
      lifetimeBudget: false,
    });
    const plan = await buildPlan(redditConfig(), fakeClient('reddit', state), options);
    expect(
      plan.operations.some((operation) => 'target' in operation && JSON.stringify(operation.target).includes('live-1')),
    ).toBe(false);
  });

  it('writes nothing for an ADOPT_PENDING campaign and says so', async () => {
    const state = emptyAccount();
    liveManaged(state, 'ACTIVE');
    const config = withChanges((draft) => (draft.campaigns[0].status = 'ADOPT_PENDING'));
    const plan = await buildPlan(config, fakeClient('reddit', state), options);
    expect(plan.operations).toEqual([]);
    expect(plan.pending[0]).toMatch(/adoption pending/);
  });

  it('blocks when an adopted id is missing from the account', async () => {
    const plan = await buildPlan(
      redditConfig({ adoptCampaignIds: [{ id: 'gone', code: 'nov26-launch' }] }),
      fakeClient('reddit', emptyAccount()),
      options,
    );
    expect(plan.blocked[0]).toMatch(/was not found/);
    expect(plan.operations).toEqual([]);
  });

  it('refuses ambiguous live names', async () => {
    const state = emptyAccount();
    liveManaged(state);
    state.adGroups.push({ ...state.adGroups[0], id: 'g-dupe' });
    await expect(buildPlan(redditConfig(), fakeClient('reddit', state), options)).rejects.toThrow(/Ambiguous ad group/);
  });

  it('refuses an account or currency that does not match', async () => {
    await expect(
      buildPlan(redditConfig(), fakeClient('reddit', emptyAccount(), { id: 'acct1', currency: 'USD' }), options),
    ).rejects.toThrow(/currency/);
    await expect(
      buildPlan(redditConfig(), fakeClient('reddit', emptyAccount(), { id: 'other', currency: 'AUD' }), options),
    ).rejects.toThrow(/account/);
  });

  it('repairs a drifted Reddit destination', async () => {
    const state = emptyAccount();
    liveManaged(state);
    state.ads[0].destination = 'https://www.boardsesh.com/?utm_source=reddit';
    const plan = await buildPlan(redditConfig(), fakeClient('reddit', state), options);
    expect(plan.operations).toEqual([
      expect.objectContaining({
        kind: 'ad',
        target: { id: 'a1' },
        patch: {
          destination:
            'https://www.boardsesh.com/?utm_source=reddit&utm_medium=paid-social&utm_campaign=nov26-launch&utm_content=homewalls-ad-1',
        },
      }),
    ]);
  });

  it('blocks live lifetime budgets, objective changes, budget-level changes and end-date clearing', async () => {
    const state = emptyAccount();
    liveManaged(state);
    state.campaigns[0].objective = 'IMPRESSIONS';
    state.adGroups[0].lifetimeBudget = true;
    const config = withChanges((draft) => (draft.campaigns[0].endDate = null));
    const plan = await buildPlan(config, fakeClient('reddit', state), options);
    expect(plan.blocked.join('\n')).toMatch(/objective IMPRESSIONS/);
    expect(plan.blocked.join('\n')).toMatch(/lifetime budget/);
    expect(plan.blocked.join('\n')).toMatch(/clearing a live end date/);
    const cbo = withChanges((draft) => {
      draft.campaigns[0].dailyBudget = '10.00';
      delete draft.campaigns[0].adGroups[0].dailyBudget;
    });
    const levelState = emptyAccount();
    liveManaged(levelState);
    expect((await buildPlan(cbo, fakeClient('reddit', levelState), options)).blocked.join('\n')).toMatch(
      /budget level differs/,
    );
  });

  it('marks ads without a post id and ad groups without a pixel as pending instead of creating them', async () => {
    const config = withChanges((draft) => (draft.campaigns[0].adGroups[0].ads[0].creative = { postId: null }));
    const plan = await buildPlan(config, fakeClient('reddit', emptyAccount()), options);
    expect(plan.pending).toEqual(['nov26-launch / homewalls / homewalls-ad-1: needs a postId']);
    expect(plan.operations.some((operation) => operation.kind === 'ad')).toBe(false);
    const noPixel = await buildPlan(
      redditConfig({ reddit: { pixelId: null } }),
      fakeClient('reddit', emptyAccount()),
      options,
    );
    expect(noPixel.pending[0]).toMatch(/pixelId/);
    expect(noPixel.operations.some((operation) => operation.kind === 'adGroup')).toBe(false);
  });
});

describe('spend guardrails', () => {
  it('refuses a budget more than double the live value', async () => {
    const state = emptyAccount();
    liveManaged(state, 'ACTIVE', 1000);
    const config = activeConfig();
    config.campaigns[0].adGroups[0].dailyBudget = '20.01';
    const plan = await buildPlan(config, fakeClient('reddit', state), options);
    expect(plan.blocked.join('\n')).toMatch(/10.00 -> 20.01 is more than 2x/);
  });

  it('allows exactly double', async () => {
    const state = emptyAccount();
    liveManaged(state, 'ACTIVE', 1000);
    const config = activeConfig();
    config.campaigns[0].adGroups[0].dailyBudget = '20.00';
    expect((await buildPlan(config, fakeClient('reddit', state), options)).blocked).toEqual([]);
  });

  it('allows a bigger jump only with allowBudgetJump', async () => {
    const state = emptyAccount();
    liveManaged(state, 'ACTIVE', 1000);
    const config = activeConfig({ allowBudgetJump: true });
    config.campaigns[0].adGroups[0].dailyBudget = '45.00';
    expect((await buildPlan(config, fakeClient('reddit', state), options)).blocked).toEqual([]);
  });

  it('counts starting spend from zero as a jump', async () => {
    const plan = await buildPlan(activeConfig(), fakeClient('reddit', emptyAccount()), options);
    expect(plan.blocked.join('\n')).toMatch(/0.00 -> 10.00 is more than 2x \(starting spend from zero counts\)/);
  });

  it('counts a new active ad group toward the total jump', async () => {
    const state = emptyAccount();
    liveManaged(state, 'ACTIVE', 500);
    const config = activeConfig();
    config.campaigns[0].adGroups[0].dailyBudget = '5.00';
    config.campaigns[0].adGroups.push({
      ...clone(config.campaigns[0].adGroups[0]),
      name: 'spray',
      dailyBudget: '10.00',
      ads: [{ name: 'spray-1', status: 'ACTIVE', creative: { postId: 't3_spray' } }],
    });
    const plan = await buildPlan(config, fakeClient('reddit', state), options);
    expect(plan.blocked.join('\n')).toMatch(/5.00 -> 15.00/);
  });

  it('caps planned spend even if a caller bypassed validateConfig', () => {
    const config = redditConfig({ maxDailyBudgetTotal: '5.00' });
    expect(planGuardrails(config, { operations: [], liveActiveCents: 500, plannedActiveCents: 600 })).toEqual([
      expect.stringMatching(/exceed maxDailyBudgetTotal 5.00/),
    ]);
  });

  it('apply makes no write at all when the plan is blocked', async () => {
    const state = emptyAccount();
    await expect(reconcile(activeConfig(), fakeClient('reddit', state), 'apply', options)).rejects.toThrow(
      /Apply refused before any write/,
    );
    expect(state.calls).toEqual([]);
  });

  it('apply re-validates the config itself', async () => {
    const config = activeConfig({ maxDailyBudgetTotal: '5.00', allowBudgetJump: true });
    const state = emptyAccount();
    await expect(reconcile(config, fakeClient('reddit', state), 'apply', options)).rejects.toThrow(
      /above maxDailyBudgetTotal/,
    );
    expect(state.calls).toEqual([]);
  });
});

describe('apply and read-back', () => {
  it('creates paused, activates last, and reads back clean', async () => {
    const state = emptyAccount();
    const report = await reconcile(
      activeConfig({ allowBudgetJump: true }),
      fakeClient('reddit', state),
      'apply',
      options,
    );
    expect(state.calls.map((call) => call.method)).toEqual([
      'createCampaign',
      'createAdGroup',
      'createAd',
      'updateAd',
      'updateAdGroup',
      'updateCampaign',
    ]);
    expect(state.calls.slice(3).map((call) => (call.payload as { status: string }).status)).toEqual([
      'ACTIVE',
      'ACTIVE',
      'ACTIVE',
    ]);
    expect(report.readbackMismatches).toEqual([]);
    expect(report.warnings[0]).toMatch(/allowBudgetJump is on/);
  });

  it('a second apply of the same config writes nothing', async () => {
    const state = emptyAccount();
    await reconcile(redditConfig(), fakeClient('reddit', state), 'apply', options);
    const writes = state.calls.length;
    const report = await reconcile(redditConfig(), fakeClient('reddit', state), 'apply', options);
    expect(state.calls.length).toBe(writes);
    expect(report.operations).toEqual([]);
  });

  it('reports a write that did not land', async () => {
    const state = emptyAccount();
    liveManaged(state, 'ACTIVE', 1000);
    state.dropWrites = new Set(['updateAdGroup']);
    const config = activeConfig();
    config.campaigns[0].adGroups[0].dailyBudget = '15.00';
    const report = await reconcile(config, fakeClient('reddit', state), 'apply', options);
    expect(report.readbackMismatches).toEqual([
      expect.objectContaining({
        kind: 'adGroup',
        action: 'update',
        fields: expect.objectContaining({ dailyBudget: '15.00' }),
      }),
    ]);
  });

  it('plan never writes', async () => {
    const state = emptyAccount();
    liveManaged(state, 'ACTIVE');
    await reconcile(redditConfig(), fakeClient('reddit', state), 'plan', options);
    expect(state.calls).toEqual([]);
  });

  it('executePlan refuses a status that would delete or archive', async () => {
    const forged = [
      {
        phase: 1,
        kind: 'campaign',
        action: 'update',
        path: 'x',
        target: { id: 'c1' },
        patch: { status: 'DELETED' },
        liveDailyBudgetCents: null,
      },
    ] as unknown as Operation[];
    const state = emptyAccount();
    liveManaged(state);
    await expect(executePlan(fakeClient('reddit', state), forged)).rejects.toThrow(/ACTIVE or PAUSED/);
    expect(state.calls).toEqual([]);
  });
});

describe('audit', () => {
  it('lists foreign and managed campaigns without writing', async () => {
    const state = emptyAccount();
    liveManaged(state, 'ACTIVE');
    state.campaigns.push({
      id: 'foreign',
      name: 'Marco test',
      status: 'PAUSED',
      objective: 'CLICKS',
      dailyBudgetCents: null,
      lifetimeBudget: false,
    });
    const report = await reconcile(redditConfig(), fakeClient('reddit', state), 'audit', options);
    expect(report.campaigns?.map((campaign) => [campaign.id, campaign.managed])).toEqual([
      ['c1', true],
      ['foreign', false],
    ]);
    expect(report.liveActiveDailyBudget).toBe('10.00');
    expect(state.calls).toEqual([]);
  });

  it('warns instead of failing on a currency mismatch so the config can be fixed', async () => {
    const report = await reconcile(
      redditConfig(),
      fakeClient('reddit', emptyAccount(), { id: 'acct1', currency: 'USD' }),
      'audit',
      options,
    );
    expect(report.warnings).toEqual(['Account currency is USD; set currency in the config to match']);
  });
});

describe('Meta creatives', () => {
  const metaBase = (): PaidSocialConfig => ({
    version: 1,
    platform: 'meta',
    adAccountId: 'acct1',
    currency: 'AUD',
    namespace: 'Boardsesh Managed',
    maxDailyBudgetTotal: '50.00',
    allowBudgetJump: false,
    adoptCampaignIds: [],
    meta: { pageId: '111', instagramUserId: '222' },
    campaigns: [
      {
        code: 'nov26-launch',
        status: 'PAUSED',
        objective: 'OUTCOME_TRAFFIC',
        startDate: '2026-11-01',
        endDate: '2026-11-30',
        adGroups: [
          {
            name: 'homewalls',
            status: 'PAUSED',
            dailyBudget: '10.00',
            targeting: {
              countries: ['US'],
              placements: ['stream'],
              interests: [{ id: '6003', name: 'Rock climbing' }],
            },
            ads: [
              {
                name: 'homewalls-ad-1',
                status: 'PAUSED',
                creative: {
                  image: 'app-stores/paid-social/creatives/homewall.jpg',
                  headline: 'Your home wall, lit',
                  body: 'Light your climbs from your phone.',
                  callToAction: 'LEARN_MORE',
                },
              },
            ],
          },
        ],
      },
    ],
  });

  it('uploads a creative once, with the macro url_tags, and finds it by content hash afterwards', async () => {
    const config = validateConfig(metaBase(), 'meta');
    const state = emptyAccount();
    await reconcile(config, fakeClient('meta', state), 'apply', options);
    const creativeCalls = state.calls.filter((call) => call.method === 'createCreative');
    expect(creativeCalls).toHaveLength(1);
    expect(creativeCalls[0].payload).toMatchObject({
      link: 'https://www.boardsesh.com/',
      urlTags: 'utm_source=instagram&utm_medium=paid-social&utm_campaign=nov26-launch&utm_content=homewalls-ad-1',
    });
    const before = state.calls.length;
    const report = await reconcile(config, fakeClient('meta', state), 'apply', options);
    expect(state.calls.length).toBe(before);
    expect(report.operations).toEqual([]);
  });

  it('a copy change creates a new creative and repoints the ad', async () => {
    const config = validateConfig(metaBase(), 'meta');
    const state = emptyAccount();
    await reconcile(config, fakeClient('meta', state), 'apply', options);
    const edited = clone(config);
    const creative = edited.campaigns[0].adGroups[0].ads[0].creative as { body: string };
    creative.body = 'New copy.';
    const plan = await buildPlan(edited, fakeClient('meta', state), options);
    expect(plan.operations.map((operation) => `${operation.kind}:${operation.action}`)).toEqual([
      'creative:create',
      'ad:update',
    ]);
    expect(
      fileCreativeName(edited, edited.campaigns[0].adGroups[0].ads[0], creative as never, IMAGE, edited.campaigns[0]),
    ).not.toBe(
      fileCreativeName(
        config,
        config.campaigns[0].adGroups[0].ads[0],
        config.campaigns[0].adGroups[0].ads[0].creative as never,
        IMAGE,
        config.campaigns[0],
      ),
    );
  });

  it('warns when an adopted creative points somewhere else', async () => {
    const config = withChanges((draft) => {
      draft.campaigns[0].adGroups[0].ads[0].creative = { existingCreativeId: 'cr1' };
    }, metaBase());
    const state = emptyAccount();
    state.campaigns.push({
      id: 'c1',
      name: 'Boardsesh Managed nov26-launch',
      status: 'PAUSED',
      objective: 'OUTCOME_TRAFFIC',
      dailyBudgetCents: null,
      lifetimeBudget: false,
    });
    state.adGroups.push({
      id: 'g1',
      name: 'homewalls',
      campaignId: 'c1',
      status: 'PAUSED',
      dailyBudgetCents: 1000,
      lifetimeBudget: false,
      endDate: '2026-11-30',
      targeting: {
        countries: ['US'],
        placements: ['stream'],
        interests: ['6003'],
        communities: [],
        ageMin: 18,
        ageMax: 65,
      },
    });
    state.ads.push({
      id: 'a1',
      name: 'homewalls-ad-1',
      adGroupId: 'g1',
      status: 'PAUSED',
      destination: 'https://www.boardsesh.com/',
      creativeId: 'cr1',
      creativeName: 'old',
    });
    const plan = await buildPlan(config, fakeClient('meta', state), options);
    expect(plan.operations).toEqual([]);
    expect(plan.warnings[0]).toMatch(/live destination https:\/\/www.boardsesh.com\/ differs/);
  });

  it('marks file creatives pending until the page and Instagram account are set', async () => {
    const config = metaBase();
    config.meta = { pageId: null, instagramUserId: null };
    const plan = await buildPlan(config, fakeClient('meta', emptyAccount()), options);
    expect(plan.pending[0]).toMatch(/meta.pageId and meta.instagramUserId/);
    expect(plan.operations.some((operation) => operation.kind === 'ad' || operation.kind === 'creative')).toBe(false);
  });
});

describe('toCents', () => {
  it('parses decimal strings without float error', () => {
    expect(toCents('0.29')).toBe(29);
    expect(toCents('10')).toBe(1000);
    expect(toCents('12.5')).toBe(1250);
  });
});
