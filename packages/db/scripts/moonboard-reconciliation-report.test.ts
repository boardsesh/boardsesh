import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReconciliationReport,
  holdDifferences,
  planResidualGroups,
  type ReconciliationClimb,
} from './moonboard-reconciliation-report.js';
import {
  catalogClimbUuid,
  catalogProblemToClimbs,
  legacyCatalogClimbUuid,
  type MoonBoardCatalogProblem,
} from './moonboard-catalog-helpers.js';

const problem: MoonBoardCatalogProblem = {
  id: 5253,
  name: 'Same',
  moves: 's~A1~|r~B2~|e~C3~',
  configurations: [{ apiId: 1, configuration: '40°', grade: '7A', repeats: 20 }],
};
const mapped = catalogProblemToClimbs(problem, 2)!;
const entry = { layoutId: 2, problem };
function climb(uuid: string, overrides: Partial<ReconciliationClimb> = {}): ReconciliationClimb {
  return {
    uuid,
    layoutId: 2,
    name: 'Same',
    angle: 40,
    createdAt: '2024-01-01',
    isListed: true,
    isDraft: false,
    userId: null,
    framesCount: 1,
    fingerprint: mapped.holdFingerprint,
    stats: [{ angle: 40, upstream: 20 }],
    ...overrides,
  };
}

void test('projects ambiguous same-angle imports to one canonical and keeps MAX for double imports', () => {
  const report = buildReconciliationReport([entry], [entry], { climbs: [climb('b'), climb('a')], aliases: new Map() });
  assert.deepEqual(report.counts, { ambiguous: 1, drifted: 0, hijacked: 0 });
  assert.deepEqual(report.projectedCounts, { ambiguous: 0, drifted: 0, hijacked: 0 });
  assert.deepEqual(report.groups[0].stats, [{ angle: 40, policy: 'MAX', upstream: 20 }]);
  assert.equal(report.groups[0].canonicalUuid, 'a');
  assert.equal(report.skipped[0].history.status, 'unchanged-holds');
});

void test('selects angle-null roots by peak upstream and sums independent cohorts per angle', () => {
  const groups = planResidualGroups({
    climbs: [
      climb('legacy', {
        stats: [
          { angle: 40, upstream: 10 },
          { angle: 25, upstream: 3 },
        ],
      }),
      climb('null-angle', {
        angle: null,
        name: 'Different',
        stats: [
          { angle: 40, upstream: 50 },
          { angle: 25, upstream: 4 },
        ],
      }),
    ],
    aliases: new Map(),
  });
  assert.equal(groups[0].canonicalUuid, 'null-angle');
  assert.deepEqual(groups[0].stats, [
    { angle: 25, policy: 'SUM', upstream: 7 },
    { angle: 40, policy: 'SUM', upstream: 60 },
  ]);
});

void test('same names with unequal counts sum; null counts become zero; unknown names do not prove duplicates', () => {
  for (const [names, counts, expected] of [
    [['Same', 'same'], [10, 20], { angle: 40, policy: 'SUM', upstream: 30 }],
    [['Same', 'same'], [null, 0], { angle: 40, policy: 'MAX', upstream: 0 }],
    [[null, 'same'], [10, 10], { angle: 40, policy: 'SUM', upstream: 20 }],
  ] as const) {
    const groups = planResidualGroups({
      climbs: names.map((name, index) =>
        climb(`climb-${index}`, { name, stats: [{ angle: 40, upstream: counts[index] }] }),
      ),
      aliases: new Map(),
    });
    assert.deepEqual(groups[0].stats, [expected]);
  }
});

void test('never counts old aliases, unlisted rows, user content, drafts, or other layouts', () => {
  const excluded = [
    climb('unlisted', { isListed: false }),
    climb('unknown-listing', { isListed: null }),
    climb('owned', { userId: 'user' }),
    climb('draft', { isDraft: true }),
    climb('multiframe', { framesCount: 2 }),
    climb('holdless', { fingerprint: null }),
    climb('other-layout', { layoutId: 3 }),
    climb('redirect'),
  ];
  const groups = planResidualGroups({
    climbs: [climb('a'), climb('b'), ...excluded],
    aliases: new Map([['redirect', 'a']]),
  });
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].memberUuids, ['a', 'b']);
  assert.equal(groups[0].eligible, true);
});

void test('outside redirects and cycles block the whole signature group', () => {
  for (const aliases of [
    new Map([['redirect', 'elsewhere']]),
    new Map([
      ['redirect', 'cycle'],
      ['cycle', 'redirect'],
    ]),
  ]) {
    const groups = planResidualGroups({ climbs: [climb('a'), climb('b'), climb('redirect')], aliases });
    assert.equal(groups[0].eligible, false);
    assert.deepEqual(groups[0].conflictingRedirectUuids, ['redirect']);
  }
});

void test('a duplicate merge can expose a hijacked problem with differing owned holds', () => {
  const owned = legacyCatalogClimbUuid({ id: problem.id, angle: 25 });
  const report = buildReconciliationReport([entry], [entry], {
    climbs: [climb('a'), climb('b'), climb(owned, { fingerprint: 'different', angle: 25 })],
    aliases: new Map(),
  });
  assert.equal(report.skipped[0].reason, 'ambiguous');
  assert.equal(report.skipped[0].projectedReason, 'hijacked');
  assert.deepEqual(report.skipped[0].ownedUuids, [owned]);
  assert.equal(report.projectedCounts.hijacked, 1);
});

void test('drift history distinguishes actual hold changes from reordered tokens and missing history', () => {
  const owned = catalogClimbUuid({ id: problem.id });
  const snapshot = { climbs: [climb(owned, { fingerprint: 'different' })], aliases: new Map<string, string>() };
  for (const [previous, status, changed] of [
    [[{ ...entry, problem: { ...problem, moves: 'e~C3~|s~A1~|r~B2~' } }], 'unchanged-holds', true],
    [[{ ...entry, problem: { ...problem, moves: 's~A1~|e~D4~' } }], 'changed-holds', true],
    [[], 'no-previous-holds', null],
  ] as const) {
    const report = buildReconciliationReport([entry], [...previous], snapshot);
    assert.equal(report.skipped[0].reason, 'drifted');
    assert.equal(report.skipped[0].history.status, status);
    assert.equal(report.skipped[0].history.rawMovesChanged, changed);
  }
});

void test('historical withdrawal or missing grades do not hide previous moves', () => {
  const report = buildReconciliationReport(
    [entry],
    [{ ...entry, problem: { ...problem, dateDeleted: '2024-01-01', configurations: null } }],
    { climbs: [climb(catalogClimbUuid(problem), { fingerprint: 'different' })], aliases: new Map() },
  );
  assert.equal(report.skipped[0].history.status, 'unchanged-holds');
});

void test('resolved aliases behave like the importer; cyclic owned aliases remain hijacked', () => {
  const owned = catalogClimbUuid(problem);
  const snapshot = {
    climbs: [climb('target'), climb(owned, { isListed: false })],
    aliases: new Map([[owned, 'target']]),
  };
  assert.equal(buildReconciliationReport([entry], [], snapshot).skipped.length, 0);
  snapshot.aliases = new Map([
    [owned, 'cycle'],
    ['cycle', owned],
  ]);
  const report = buildReconciliationReport([entry], [], snapshot);
  assert.equal(report.skipped[0].reason, 'hijacked');
  assert.ok(report.skipped[0].referencedUuids.includes(owned));
});

void test('ambiguous reports retain problem identities that exist only as aliases', () => {
  const identity = catalogClimbUuid(problem);
  const report = buildReconciliationReport([entry], [], {
    climbs: [climb('a'), climb('b')],
    aliases: new Map([[identity, 'a']]),
  });
  assert.deepEqual(report.skipped[0].identityAliases, [
    { uuid: identity, isClimbRow: false, redirect: 'a', terminalUuid: 'a' },
  ]);
  assert.ok(report.skipped[0].referencedUuids.includes(identity));
});

void test('hold diffs separately explain cells added, removed and changed roles', () => {
  assert.deepEqual(
    holdDifferences(
      [
        { holdId: 1, holdState: 'STARTING' },
        { holdId: 2, holdState: 'HAND' },
      ],
      [
        { holdId: 1, holdState: 'HAND' },
        { holdId: 3, holdState: 'FINISH' },
      ],
    ),
    {
      added: [{ holdId: 3, holdState: 'FINISH' }],
      removed: [{ holdId: 2, holdState: 'HAND' }],
      changedRoles: [{ holdId: 1, before: 'STARTING', after: 'HAND' }],
    },
  );
});
