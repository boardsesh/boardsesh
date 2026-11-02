import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectsRailwayRun, serverReadiness, touchesRailwayApply } from './mobile-ota-server-ready.mjs';

const done = (conclusion) => ({ status: 'completed', conclusion });

test('proceeds at once when the commit has no Railway Config run and changed no Railway config', () => {
  assert.equal(serverReadiness({ runs: [], expectRun: false, appearDeadlinePassed: false }), 'proceed');
});

test('waits for a run the commit should have triggered, then fails if it never appears', () => {
  assert.equal(serverReadiness({ runs: [], expectRun: true, appearDeadlinePassed: false }), 'wait');
  assert.equal(serverReadiness({ runs: [], expectRun: true, appearDeadlinePassed: true }), 'fail');
});

test('waits while any run is still in progress', () => {
  const running = { status: 'in_progress', conclusion: null };
  assert.equal(serverReadiness({ runs: [running], expectRun: true, appearDeadlinePassed: true }), 'wait');
  assert.equal(
    serverReadiness({ runs: [done('success'), running], expectRun: false, appearDeadlinePassed: false }),
    'wait',
  );
});

test('proceeds only when every run succeeded', () => {
  assert.equal(serverReadiness({ runs: [done('success')], expectRun: true, appearDeadlinePassed: false }), 'proceed');
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped', null]) {
    assert.equal(serverReadiness({ runs: [done(conclusion)], expectRun: true, appearDeadlinePassed: false }), 'fail');
  }
});

test('recognises exactly the paths that trigger the Railway apply job', () => {
  assert.equal(touchesRailwayApply(['infra/railway/config.ts']), true);
  assert.equal(touchesRailwayApply(['scripts/railway-apply.ts']), true);
  assert.equal(touchesRailwayApply(['.github/workflows/railway-drift.yml']), true);
  assert.equal(touchesRailwayApply(['scripts/railway-apply.test.ts', 'packages/mobile/app.config.ts']), false);
  assert.equal(touchesRailwayApply([]), false);
});

test('expects a Railway Config run only for a push to main that changed Railway config', () => {
  const railwayChange = ['.github/workflows/railway-drift.yml'];
  assert.equal(expectsRailwayRun({ ref: 'refs/heads/main', changedFiles: railwayChange }), true);
  assert.equal(expectsRailwayRun({ ref: 'refs/heads/main', changedFiles: ['packages/mobile/app.config.ts'] }), false);
  // A release/next sync merge carries main's Railway change, but Railway Config never runs for it.
  assert.equal(expectsRailwayRun({ ref: 'refs/heads/release/next', changedFiles: railwayChange }), false);
  assert.equal(expectsRailwayRun({ ref: '', changedFiles: railwayChange }), false);
});
