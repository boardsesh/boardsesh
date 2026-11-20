import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  expectsRailwayRun,
  pushBase,
  selectHomelabRuns,
  serverReadiness,
  touchesRailwayApply,
} from './mobile-ota-server-ready.mjs';

const done = (conclusion) => ({ status: 'completed', conclusion });

await test('proceeds at once when the commit has no Railway Config run and changed no Railway config', () => {
  assert.equal(serverReadiness({ runs: [], expectRun: false, appearDeadlinePassed: false }), 'proceed');
});

await test('waits for a run the commit should have triggered, then fails if it never appears', () => {
  assert.equal(serverReadiness({ runs: [], expectRun: true, appearDeadlinePassed: false }), 'wait');
  assert.equal(serverReadiness({ runs: [], expectRun: true, appearDeadlinePassed: true }), 'fail');
});

await test('waits while any run is still in progress', () => {
  const running = { status: 'in_progress', conclusion: null };
  assert.equal(serverReadiness({ runs: [running], expectRun: true, appearDeadlinePassed: true }), 'wait');
  assert.equal(
    serverReadiness({ runs: [done('success'), running], expectRun: false, appearDeadlinePassed: false }),
    'wait',
  );
});

await test('proceeds only when every run succeeded', () => {
  assert.equal(serverReadiness({ runs: [done('success')], expectRun: true, appearDeadlinePassed: false }), 'proceed');
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped', null]) {
    assert.equal(serverReadiness({ runs: [done(conclusion)], expectRun: true, appearDeadlinePassed: false }), 'fail');
  }
});

await test('recognises exactly the paths that trigger the Railway apply job', () => {
  assert.equal(touchesRailwayApply(['infra/railway/config.ts']), true);
  assert.equal(touchesRailwayApply(['scripts/railway-apply.ts']), true);
  assert.equal(touchesRailwayApply(['.github/workflows/railway-drift.yml']), true);
  assert.equal(touchesRailwayApply(['scripts/railway-apply.test.ts', 'packages/mobile/app.config.ts']), false);
  assert.equal(touchesRailwayApply([]), false);
});

await test('expects a Railway Config run only for a push to main that changed Railway config', () => {
  const railwayChange = ['.github/workflows/railway-drift.yml'];
  assert.equal(expectsRailwayRun({ ref: 'refs/heads/main', changedFiles: railwayChange }), true);
  assert.equal(expectsRailwayRun({ ref: 'refs/heads/main', changedFiles: ['packages/mobile/app.config.ts'] }), false);
  // A release/next sync merge carries main's Railway change, but Railway Config never runs for it.
  assert.equal(expectsRailwayRun({ ref: 'refs/heads/release/next', changedFiles: railwayChange }), false);
  assert.equal(expectsRailwayRun({ ref: '', changedFiles: railwayChange }), false);
});

await test('uses the whole pushed range so earlier upgrade commits cannot escape the gate', () => {
  const before = 'a'.repeat(40);
  assert.equal(pushBase({ before }), before);
  assert.equal(pushBase({ before: '0'.repeat(40) }), 'HEAD~1');
  assert.equal(pushBase({}), 'HEAD~1');
});

const history = ['1'.repeat(40), '2'.repeat(40), '3'.repeat(40), '4'.repeat(40)];
const inheritedRelease = {
  version: '3.2.6',
  repository: 'ghcr.io/mercuretechnologies/expo-open-ota',
  digest: `sha256:${'a'.repeat(64)}`,
};
const requirement = { requiredSha: history[1], targetSha: history[2], release: inheritedRelease };
const historyEvidence = {
  isAncestor: (a, b) => history.includes(a) && history.includes(b) && history.indexOf(a) <= history.indexOf(b),
  distance: (a, b) => history.indexOf(b) - history.indexOf(a),
  releaseAt: () => inheritedRelease,
  providerAt: () => 'homelab',
};
const deployRun = (sha, status = 'completed', conclusion = 'success') => ({
  head_sha: sha,
  head_branch: 'main',
  event: 'push',
  status,
  conclusion,
});

await test('a later mobile-only commit waits for its ancestor upgrade rather than skipping', () => {
  const running = deployRun(history[1], 'in_progress', null);
  const runs = selectHomelabRuns([running, deployRun(history[0])], requirement, historyEvidence);
  assert.deepEqual(runs, [running]);
  assert.equal(serverReadiness({ runs, expectRun: true, appearDeadlinePassed: false }), 'wait');
  assert.deepEqual(selectHomelabRuns([deployRun(history[0])], requirement, historyEvidence), []);
});

await test('a multi-commit push is acknowledged at its push head', () => {
  const run = deployRun(history[2]);
  assert.deepEqual(selectHomelabRuns([run], requirement, historyEvidence), [run]);
});

await test('ancestor acknowledgments reject wrong branches, future sources and malformed commits', () => {
  assert.deepEqual(
    selectHomelabRuns(
      [
        { ...deployRun(history[1]), head_branch: 'feature' },
        { ...deployRun(history[1]), event: 'workflow_dispatch' },
        deployRun(history[3]),
        deployRun('not-a-sha'),
      ],
      requirement,
      historyEvidence,
    ),
    [],
  );
});

await test('ancestor success must verify the same digest and homelab ownership', () => {
  assert.throws(
    () =>
      selectHomelabRuns([deployRun(history[1])], requirement, {
        ...historyEvidence,
        releaseAt: () => ({ ...inheritedRelease, digest: `sha256:${'b'.repeat(64)}` }),
      }),
    /does not match/,
  );
  assert.throws(
    () =>
      selectHomelabRuns([deployRun(history[1])], requirement, {
        ...historyEvidence,
        providerAt: () => 'railway',
      }),
    /does not match/,
  );
  assert.throws(
    () =>
      selectHomelabRuns([deployRun(history[1])], requirement, {
        ...historyEvidence,
        releaseAt: () => null,
      }),
    /does not match/,
  );
});

await test('latest eligible deployment supersedes older results but must itself finish', () => {
  const olderFailed = deployRun(history[1], 'completed', 'failure');
  const newest = deployRun(history[2]);
  assert.deepEqual(selectHomelabRuns([olderFailed, newest], requirement, historyEvidence), [newest]);
  const running = { ...newest, status: 'in_progress', conclusion: null };
  const runs = selectHomelabRuns([deployRun(history[1]), running], requirement, historyEvidence);
  assert.deepEqual(runs, [running]);
  assert.equal(serverReadiness({ runs, expectRun: true, appearDeadlinePassed: false }), 'wait');
  const failed = selectHomelabRuns(
    [deployRun(history[1]), { ...newest, conclusion: 'failure' }],
    requirement,
    historyEvidence,
  );
  assert.equal(serverReadiness({ runs: failed, expectRun: true, appearDeadlinePassed: false }), 'fail');
});
