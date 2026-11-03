/** Instagram-app boosts: lifetime-budget campaigns that stay unmanaged, and the seeded Meta mirror of the live one. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import { metaTargetingBody, metaTargetingOf } from '../lib/meta-ads-client';
import {
  buildPlan,
  desiredTargeting,
  reconcile,
  validateConfig,
  type PaidSocialConfig,
  type PlanOptions,
} from '../lib/paid-social';
import { emptyAccount, fakeClient, liveTargeting, redditConfig, type FakeAccount } from './helpers/fake-paid-social';

const options: PlanOptions = {
  readCreativeFile: async () => new Uint8Array([1]),
  now: () => new Date('2026-11-03T00:00:00Z'),
};
const seededMeta = () => validateConfig(JSON.parse(readFileSync('app-stores/meta/ads.json', 'utf8')), 'meta');

function addBoost(state: FakeAccount, name: string) {
  state.campaigns.push({
    id: 'boost-1',
    name,
    status: 'ACTIVE',
    objective: 'OUTCOME_ENGAGEMENT',
    dailyBudgetCents: null,
    lifetimeBudget: false,
  });
  // Meta boosts carry the lifetime budget on the ad set.
  state.adGroups.push({
    id: 'boost-set',
    name: 'Boost',
    campaignId: 'boost-1',
    status: 'ACTIVE',
    dailyBudgetCents: null,
    lifetimeBudget: true,
    endDate: '2026-11-30',
    targeting: liveTargeting(),
  });
}

describe('boosts', () => {
  it('audit lists a boost as unmanaged because of its lifetime budget, without failing', async () => {
    const state = emptyAccount();
    addBoost(state, 'Instagram post: Light your home wall');
    const report = await reconcile(redditConfig(), fakeClient('reddit', state), 'audit', options);
    expect(report.campaigns).toEqual([
      expect.objectContaining({
        id: 'boost-1',
        managed: false,
        unmanagedReason: 'lifetime budget (an Instagram boost or a lifetime campaign): cannot be adopted',
      }),
    ]);
    expect(state.calls).toEqual([]);
  });

  it('a boost carrying the campaign code does not block a managed replacement, but is called out', async () => {
    const state = emptyAccount();
    addBoost(state, 'nov26-launch boost');
    const plan = await buildPlan(redditConfig(), fakeClient('reddit', state), options);
    expect(plan.blocked).toEqual([]);
    expect(plan.warnings).toEqual([expect.stringMatching(/boost-1 carries this code but has a lifetime budget/)]);
    expect(plan.operations[0]).toMatchObject({ kind: 'campaign', action: 'create' });
    expect(
      plan.operations.some((operation) => 'target' in operation && JSON.stringify(operation.target).includes('boost')),
    ).toBe(false);
  });

  it('adopting a boost is refused', async () => {
    const state = emptyAccount();
    addBoost(state, 'Instagram post');
    state.adGroups[0].name = 'homewalls';
    const plan = await buildPlan(
      redditConfig({ adoptCampaignIds: [{ id: 'boost-1', code: 'nov26-launch' }] }),
      fakeClient('reddit', state),
      options,
    );
    expect(plan.blocked.join('\n')).toMatch(/lifetime budget/);
  });
});

describe('seeded Meta config', () => {
  it('mirrors the live boost and writes nothing', async () => {
    const config = seededMeta();
    const group = config.campaigns[0].adGroups[0];
    expect(config.currency).toBe('AUD');
    expect(config.campaigns[0].status).toBe('ADOPT_PENDING');
    expect(group.targeting).toMatchObject({ countries: ['US', 'JP', 'NL'], ageMin: 18, advantageAudience: true });
    expect(
      group.targeting.interests.map((interest) => (typeof interest === 'string' ? interest : interest.name)),
    ).toEqual(['Indoor climbing', 'Bouldering']);
    expect(group.ads[0].name).toBe('ig-boost-1');
    const state = emptyAccount();
    const plan = await buildPlan({ ...config, adAccountId: 'acct1' }, fakeClient('meta', state), options);
    expect(plan.operations).toEqual([]);
    expect(state.calls).toEqual([]);
  });

  it('holds an ad group with interests not yet looked up', async () => {
    const config: PaidSocialConfig = { ...seededMeta(), adAccountId: 'acct1' };
    config.campaigns[0].status = 'PAUSED';
    const plan = await buildPlan(config, fakeClient('meta', emptyAccount()), options);
    expect(plan.pending).toContain(
      'nov26-launch / ig-boost: look up the Meta interest id for "Indoor climbing", "Bouldering"',
    );
    expect(plan.operations.map((operation) => operation.kind)).toEqual(['campaign']);
  });

  it('sends and reads Advantage+ audience', () => {
    const config = seededMeta();
    const desired = desiredTargeting(config.campaigns[0].adGroups[0].targeting, 'meta');
    expect(desired).toMatchObject({ ageMin: 18, ageMax: 65, advantageAudience: true, interests: [] });
    expect(metaTargetingBody(desired).targeting_automation).toEqual({ advantage_audience: 1 });
    expect(metaTargetingOf({ targeting_automation: { advantage_audience: 1 } }).advantageAudience).toBe(true);
  });

  it('refuses a non-boolean advantageAudience', () => {
    const config = JSON.parse(readFileSync('app-stores/meta/ads.json', 'utf8')) as PaidSocialConfig;
    (config.campaigns[0].adGroups[0].targeting as unknown as Record<string, unknown>).advantageAudience = 'yes';
    expect(() => validateConfig(config, 'meta')).toThrow(/advantageAudience/);
  });
});
