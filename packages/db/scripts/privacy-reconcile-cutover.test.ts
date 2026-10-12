/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  privacyReconcileAcknowledgement,
  privacyReconcileScope,
  requirePrivacyReconcileCutover,
} from './privacy-reconcile-cutover.js';

const preflight = {
  tag: '0265_privacy_reconcile_tick_tombstones',
  hash: 'a'.repeat(64),
  tickStamps: '0',
  legacySessions: '3',
};

void test('an unapplied cleanup cannot precede deployment without a count-bound pause acknowledgement', () => {
  for (const acknowledgement of [
    undefined,
    '',
    'true',
    'readers-paused',
    `${'b'.repeat(64)}:0:3:readers-paused`,
    `${preflight.hash}:0:2:readers-paused`,
  ]) {
    assert.throws(() => requirePrivacyReconcileCutover(preflight, acknowledgement, '123.2'), /No migration was run/);
  }
  assert.doesNotThrow(() =>
    requirePrivacyReconcileCutover(preflight, privacyReconcileAcknowledgement(preflight, '123.2'), '123.2'),
  );
});

void test('zero rows never stand in for a paused older backend', () => {
  assert.throws(
    () => requirePrivacyReconcileCutover({ ...preflight, legacySessions: '0' }, undefined, '123.2'),
    /EVERY backend/,
  );
});

void test('an applied cleanup does not hold ordinary releases', () => {
  assert.doesNotThrow(() => requirePrivacyReconcileCutover(null, undefined, undefined));
});

void test('production arms the gate even for loopback URLs, before any migration or ACL callback', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/production-deploy.yml', import.meta.url), 'utf8');
  assert.match(workflow, /PRIVACY_RECONCILE_REQUIRE_CUTOVER: '1'/);
  assert.match(workflow, /PRIVACY_RECONCILE_CUTOVER: \$\{\{ vars.PRIVACY_RECONCILE_CUTOVER \}\}/);
  const runner = readFileSync(new URL('./migrate.ts', import.meta.url), 'utf8');
  assert.ok(
    runner.indexOf('requirePrivacyReconcileCutover(preflight') <
      runner.indexOf('await runMigrationWithRuntimeAclContract('),
  );
  assert.ok(runner.indexOf('requirePrivacyReconcileCutover(preflight') < runner.indexOf('await migrate(db,'));
});

void test('an older run or attempt cannot reuse a pause acknowledgement', () => {
  const acknowledgement = privacyReconcileAcknowledgement(preflight, '123.1');
  assert.throws(() => requirePrivacyReconcileCutover(preflight, acknowledgement, '123.2'), /No migration was run/);
  assert.throws(() => requirePrivacyReconcileCutover(preflight, acknowledgement, '124.1'), /No migration was run/);
  assert.throws(() => requirePrivacyReconcileCutover(preflight, acknowledgement, undefined), /No migration was run/);
  assert.equal(
    privacyReconcileScope({ GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' }),
    '123.2',
  );
  assert.equal(
    privacyReconcileScope({ GITHUB_ACTIONS: 'true', PRIVACY_RECONCILE_CUTOVER_SCOPE: 'old-cli-ack' }),
    undefined,
  );
  assert.equal(privacyReconcileScope({}), undefined);
  assert.equal(
    privacyReconcileScope({ PRIVACY_RECONCILE_CUTOVER_SCOPE: 'operator-2026-10-12' }),
    'operator-2026-10-12',
  );
});
