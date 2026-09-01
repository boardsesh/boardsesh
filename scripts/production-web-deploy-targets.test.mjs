import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatGithubOutputs,
  normalizeRailwayWebOrigin,
  resolveWebDeployTargets,
  workflowCommandValue,
} from './production-web-deploy-targets.mjs';

const SERVICE_ID = 'a1b2c3d4-0000-4000-8000-000000000000';
const RAILWAY_ORIGIN = 'https://boardsesh-web-production.up.railway.app';
const VERCEL_TARGET = {
  vercel: true,
  railway: false,
  targets: 'vercel',
  railwayServiceId: '',
  railwayOrigin: '',
};
const RAILWAY_TARGET = {
  vercel: false,
  railway: true,
  targets: 'railway',
  railwayServiceId: SERVICE_ID,
  railwayOrigin: RAILWAY_ORIGIN,
};
const BOTH_TARGETS = {
  vercel: true,
  railway: true,
  targets: 'vercel,railway',
  railwayServiceId: SERVICE_ID,
  railwayOrigin: RAILWAY_ORIGIN,
};
const HELD_TARGET = {
  vercel: false,
  railway: false,
  targets: 'none',
  railwayServiceId: '',
  railwayOrigin: '',
};

void test('an unset variable keeps www on Vercel', () => {
  // The merge-is-a-no-op property. If this ever defaults to anything else, the
  // PR that adds Railway wiring silently becomes a production cutover.
  assert.deepEqual(resolveWebDeployTargets({}), VERCEL_TARGET);
  assert.deepEqual(resolveWebDeployTargets({ raw: '' }), VERCEL_TARGET);
  assert.deepEqual(resolveWebDeployTargets({ raw: '   ' }), VERCEL_TARGET);
});

void test('resolves each single target', () => {
  assert.deepEqual(resolveWebDeployTargets({ raw: 'vercel' }), VERCEL_TARGET);
  assert.deepEqual(
    resolveWebDeployTargets({
      raw: 'railway',
      railwayWebServiceId: SERVICE_ID,
      railwayWebOrigin: RAILWAY_ORIGIN,
    }),
    RAILWAY_TARGET,
  );
});

void test('accepts both targets in either order, with whitespace and casing tolerated', () => {
  for (const raw of ['vercel,railway', 'railway,vercel', ' vercel , railway ', 'Vercel,RAILWAY', 'vercel,\trailway']) {
    assert.deepEqual(
      resolveWebDeployTargets({ raw, railwayWebServiceId: SERVICE_ID, railwayWebOrigin: RAILWAY_ORIGIN }),
      BOTH_TARGETS,
      raw,
    );
  }
});

void test('"none" is the web hold', () => {
  assert.deepEqual(resolveWebDeployTargets({ raw: 'none' }), HELD_TARGET);
  assert.deepEqual(resolveWebDeployTargets({ raw: ' NONE ' }), HELD_TARGET);
});

void test('rejects an unknown target rather than silently deploying nothing', () => {
  // The failure this prevents: a typo like `verel` resolving to "no targets",
  // which looks exactly like a deliberate hold in the run summary.
  assert.throws(() => resolveWebDeployTargets({ raw: 'verel' }), /unknown target/);
  assert.throws(() => resolveWebDeployTargets({ raw: 'vercel,cloudflare' }), /unknown target/);
  assert.throws(() => resolveWebDeployTargets({ raw: 'true' }), /unknown target/);
});

void test('rejects "none" mixed with a real target', () => {
  assert.throws(() => resolveWebDeployTargets({ raw: 'none,vercel' }), /cannot be combined/);
  assert.throws(
    () =>
      resolveWebDeployTargets({
        raw: 'railway,none',
        railwayWebServiceId: SERVICE_ID,
        railwayWebOrigin: RAILWAY_ORIGIN,
      }),
    /cannot be combined/,
  );
});

void test('refuses to target Railway before the service exists', () => {
  // Names the variable an operator has to set, because the alternative is a
  // `railway redeploy --service ""` two jobs later that reads as an auth error.
  for (const railwayWebServiceId of [undefined, '', '   ']) {
    assert.throws(
      () => resolveWebDeployTargets({ raw: 'railway', railwayWebServiceId }),
      /RAILWAY_WEB_SERVICE_ID/,
      String(railwayWebServiceId),
    );
  }
  assert.throws(() => resolveWebDeployTargets({ raw: 'vercel,railway' }), /RAILWAY_WEB_SERVICE_ID/);
});

void test('a missing service id never blocks a Vercel-only or held run', () => {
  assert.deepEqual(resolveWebDeployTargets({ raw: 'vercel' }).targets, 'vercel');
  assert.deepEqual(resolveWebDeployTargets({ raw: 'none' }).targets, 'none');
});

void test('requires a UUID service id instead of accepting a name or malformed id', () => {
  for (const railwayWebServiceId of [
    'boardsesh-backend',
    'not-a-uuid',
    'g1b2c3d4-0000-4000-8000-000000000000',
    'a1b2c3d4-0000-4000-8000-00000000000',
  ]) {
    assert.throws(
      () =>
        resolveWebDeployTargets({
          raw: 'railway',
          railwayWebServiceId,
          railwayWebOrigin: RAILWAY_ORIGIN,
        }),
      /service UUID/,
      railwayWebServiceId,
    );
  }
});

void test('accepts opaque Railway UUID versions while preserving canonical shape', () => {
  for (const railwayWebServiceId of ['a1b2c3d4-0000-0000-7000-000000000000', 'a1b2c3d4-0000-7000-8000-000000000000']) {
    const resolved = resolveWebDeployTargets({
      raw: 'railway',
      railwayWebServiceId,
      railwayWebOrigin: RAILWAY_ORIGIN,
    });
    assert.equal(resolved.railwayServiceId, railwayWebServiceId);
  }
});

void test('canonicalizes an uppercase Railway service UUID before publishing it', () => {
  const resolved = resolveWebDeployTargets({
    raw: 'railway',
    railwayWebServiceId: SERVICE_ID.toUpperCase(),
    railwayWebOrigin: RAILWAY_ORIGIN,
  });
  assert.equal(resolved.railwayServiceId, SERVICE_ID);
});

void test('refuses to target Railway without a post-deploy smoke origin', () => {
  for (const railwayWebOrigin of [undefined, '', '   ']) {
    assert.throws(
      () =>
        resolveWebDeployTargets({
          raw: 'railway',
          railwayWebServiceId: SERVICE_ID,
          railwayWebOrigin,
        }),
      /RAILWAY_WEB_ORIGIN/,
      String(railwayWebOrigin),
    );
  }
  assert.throws(
    () => resolveWebDeployTargets({ raw: 'vercel,railway', railwayWebServiceId: SERVICE_ID }),
    /RAILWAY_WEB_ORIGIN/,
  );
});

void test('a missing smoke origin never blocks a Vercel-only or held run', () => {
  assert.deepEqual(resolveWebDeployTargets({ raw: 'vercel' }).targets, 'vercel');
  assert.deepEqual(resolveWebDeployTargets({ raw: 'none' }).targets, 'none');
});

void test('accepts only a direct HTTPS Railway origin and normalizes its slash', () => {
  assert.equal(normalizeRailwayWebOrigin(`${RAILWAY_ORIGIN}/`), RAILWAY_ORIGIN);
  assert.equal(normalizeRailwayWebOrigin(`  ${RAILWAY_ORIGIN}  `), RAILWAY_ORIGIN);

  for (const railwayWebOrigin of [
    'not-a-url',
    'http://boardsesh-web-production.up.railway.app',
    'https://www.boardsesh.com',
    'https://user:pass@boardsesh-web-production.up.railway.app',
    'https://boardsesh-web-production.up.railway.app:444',
    'https://boardsesh-web-production.up.railway.app/path',
    'https://boardsesh-web-production.up.railway.app?wrong=service',
    'https://boardsesh-web-production.up.railway.app#fragment',
  ]) {
    assert.throws(
      () =>
        resolveWebDeployTargets({
          raw: 'railway',
          railwayWebServiceId: SERVICE_ID,
          railwayWebOrigin,
        }),
      /RAILWAY_WEB_ORIGIN/,
      railwayWebOrigin,
    );
  }
});

void test('rejects separator-only and empty target entries instead of defaulting to Vercel', () => {
  for (const raw of [',', ',,', ' , ', 'vercel,', ',railway', 'vercel,,railway']) {
    assert.throws(
      () => resolveWebDeployTargets({ raw, railwayWebServiceId: SERVICE_ID, railwayWebOrigin: RAILWAY_ORIGIN }),
      /empty target/,
      raw,
    );
  }
});

void test('duplicate entries collapse to the canonical set', () => {
  assert.deepEqual(resolveWebDeployTargets({ raw: 'vercel,vercel' }), VERCEL_TARGET);
});

void test('publishes the validated Railway identity under the workflow output names', () => {
  assert.equal(
    formatGithubOutputs(RAILWAY_TARGET),
    [
      'web_vercel=false',
      'web_railway=true',
      'web_targets=railway',
      `web_railway_service_id=${SERVICE_ID}`,
      `web_railway_origin=${RAILWAY_ORIGIN}`,
      '',
    ].join('\n'),
  );
});

void test('escapes operator-controlled text before emitting a GitHub workflow command', () => {
  assert.equal(workflowCommandValue('railway\n::error::forged%line\r'), 'railway%0A::error::forged%25line%0D');
});
