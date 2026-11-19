import { describe, expect, it } from 'vite-plus/test';
import { buildAccountConsolidationPlan, fingerprintConsolidationPlan, fingerprintConsolidationTick } from '../planner';
import { evidenceFixture, tickFixture } from './fixtures';
import { parseConsolidationArguments, runAccountConsolidationCli } from '../../consolidate-account-emails';
const options = { evidenceSha256: 'a'.repeat(64) };
const pair = [
  { userId: 'canonical', email: 'case@example.test', ticks: 1 },
  { userId: 'source', email: 'Case@Example.test', ticks: 1 },
];
const ticks = [
  tickFixture(),
  tickFixture({ id: '2', uuid: 'tick-two', userId: 'source', sessionId: 'session-two', auroraId: 'json-import-two' }),
];
describe('account consolidation planner', () => {
  it('retains the exact lowercase identity and password; chooses its existing tick even if numeric ID is greater', () => {
    const plan = buildAccountConsolidationPlan(evidenceFixture(pair), [...ticks].reverse(), options);
    expect(plan.groups[0]).toMatchObject({
      survivorUserId: 'canonical',
      sourceUserIds: ['source'],
      password: 'retain-survivor-only',
      tickMerges: [
        { retainedUuid: 'tick-one', retiredUuid: 'tick-two', sourceSessionIds: ['session-one', 'session-two'] },
      ],
      blockers: [],
    });
    expect(plan.summary).toMatchObject({
      survivorsSelected: 1,
      sourcesSelected: 1,
      duplicateTickPairs: 1,
      readyToApply: 0,
    });
    expect(plan.execution.available).toBe(false);
  });
  it('is deterministic across input member/tick ordering', () => {
    const first = buildAccountConsolidationPlan(evidenceFixture(pair), ticks, options);
    const second = buildAccountConsolidationPlan(evidenceFixture([...pair].reverse()), [...ticks].reverse(), options);
    expect(fingerprintConsolidationPlan(first)).toBe(fingerprintConsolidationPlan(second));
  });
  it('does not pick a first or oldest account when no exact lowercase member exists', () => {
    const plan = buildAccountConsolidationPlan(
      evidenceFixture(pair.map((member) => ({ ...member, email: 'Case@Example.test' }))),
      ticks,
      options,
    );
    expect(plan.groups[0]?.survivorUserId).toBeNull();
    expect(plan.groups[0]?.blockers).toContain('SURVIVOR_AMBIGUOUS');
  });
  it('requires an exact immutable-membership exception for the seven-account shape', () => {
    const members = [
      { userId: 'google', email: 'seven@example.test', password: false, providers: ['google'], otherData: true },
      ...Array.from({ length: 6 }, (_, index) => ({
        userId: `password-${index}`,
        email: 'seven@example.test',
        password: true,
      })),
    ];
    const evidence = evidenceFixture(members);
    expect(buildAccountConsolidationPlan(evidence, [], options).groups[0]?.survivorUserId).toBeNull();
    const approval = {
      normalizedEmail: 'seven@example.test',
      survivorUserId: 'google',
      memberUserIds: members.map((member) => member.userId),
    };
    expect(
      buildAccountConsolidationPlan(evidence, [], { ...options, approvedExceptions: [approval] }).groups[0],
    ).toMatchObject({ survivorUserId: 'google', password: 'provider-only' });
    expect(
      buildAccountConsolidationPlan(evidence, [], {
        ...options,
        approvedExceptions: [{ ...approval, memberUserIds: approval.memberUserIds.slice(1) }],
      }).groups[0]?.survivorUserId,
    ).toBeNull();
  });
  it.each([{ comment: 'edited' }, { climbedAt: '2026-01-01 12:00:00.000002' }, { status: 'attempt' as const }])(
    'never silently collapses different payload/time facts',
    (change) => {
      const plan = buildAccountConsolidationPlan(
        evidenceFixture(pair),
        [ticks[0], { ...ticks[1], ...change }],
        options,
      );
      expect(plan.groups[0]?.tickMerges).toHaveLength(0);
    },
  );
  it('refuses unaccounted-for tick rows instead of writing an incomplete plan', () => {
    expect(() => buildAccountConsolidationPlan(evidenceFixture(pair), ticks.slice(0, 1), options)).toThrow();
  });
  it('fingerprints raw NULL fields distinctly despite semantic duplicate equality', () => {
    expect(fingerprintConsolidationTick(tickFixture({ comment: null }))).not.toBe(
      fingerprintConsolidationTick(tickFixture({ comment: '' })),
    );
  });
  it('blocks conflicting real upstream identities and incompatible explicit sessions', () => {
    expect(
      buildAccountConsolidationPlan(
        evidenceFixture(pair),
        [
          { ...ticks[0], auroraId: 'real-one' },
          { ...ticks[1], auroraId: 'real-two' },
        ],
        options,
      ).groups[0]?.blockers,
    ).toContain('TICK_LINKAGE_CONFLICT');
    expect(
      buildAccountConsolidationPlan(
        evidenceFixture(pair),
        [ticks[0], { ...ticks[1], sessionOrigin: 'explicit' }],
        options,
      ).groups[0]?.blockers,
    ).toContain('EXPLICIT_SESSION_CONFLICT');
  });
  it('requires paired prior-plan and private exception arguments and rejects mutation flags', async () => {
    expect(() => parseConsolidationArguments(['--out', 'private.json', '--exceptions', 'exceptions.json'])).toThrow();
    expect(
      parseConsolidationArguments([
        '--out',
        'private.json',
        '--exceptions',
        'exceptions.json',
        '--prior-plan',
        'prior.json',
      ]),
    ).toMatchObject({ exceptionsFile: 'exceptions.json', priorPlanFile: 'prior.json' });
    let output = '';
    expect(
      await runAccountConsolidationCli(['--out', 'private-canary.json', '--apply'], {}, (chunk) => {
        output += chunk;
      }),
    ).toBe(1);
    expect(JSON.parse(output)).toMatchObject({ status: 'incomplete', code: 'CONFIGURATION' });
    expect(output).not.toContain('private-canary');
  });
});
