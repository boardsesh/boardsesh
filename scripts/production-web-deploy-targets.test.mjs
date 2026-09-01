import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveWebDeployTargets } from './production-web-deploy-targets.mjs';

const SERVICE_ID = 'a1b2c3d4-0000-0000-0000-000000000000';
const RAILWAY_ORIGIN = 'https://boardsesh-web-production.up.railway.app';

void test('an unset variable keeps www on Vercel', () => {
  // The merge-is-a-no-op property. If this ever defaults to anything else, the
  // PR that adds Railway wiring silently becomes a production cutover.
  assert.deepEqual(resolveWebDeployTargets({}), { vercel: true, railway: false, targets: 'vercel' });
  assert.deepEqual(resolveWebDeployTargets({ raw: '' }), { vercel: true, railway: false, targets: 'vercel' });
  assert.deepEqual(resolveWebDeployTargets({ raw: '   ' }), { vercel: true, railway: false, targets: 'vercel' });
});

void test('resolves each single target', () => {
  assert.deepEqual(resolveWebDeployTargets({ raw: 'vercel' }), { vercel: true, railway: false, targets: 'vercel' });
  assert.deepEqual(
    resolveWebDeployTargets({
      raw: 'railway',
      railwayWebServiceId: SERVICE_ID,
      railwayWebOrigin: RAILWAY_ORIGIN,
    }),
    {
      vercel: false,
      railway: true,
      targets: 'railway',
    },
  );
});

void test('accepts both targets in either order, with whitespace and casing tolerated', () => {
  const expected = { vercel: true, railway: true, targets: 'vercel,railway' };
  for (const raw of ['vercel,railway', 'railway,vercel', ' vercel , railway ', 'Vercel,RAILWAY', 'vercel,\trailway']) {
    assert.deepEqual(
      resolveWebDeployTargets({ raw, railwayWebServiceId: SERVICE_ID, railwayWebOrigin: RAILWAY_ORIGIN }),
      expected,
      raw,
    );
  }
});

void test('"none" is the web hold', () => {
  assert.deepEqual(resolveWebDeployTargets({ raw: 'none' }), { vercel: false, railway: false, targets: 'none' });
  assert.deepEqual(resolveWebDeployTargets({ raw: ' NONE ' }), { vercel: false, railway: false, targets: 'none' });
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

void test('duplicate entries collapse to the canonical set', () => {
  assert.deepEqual(resolveWebDeployTargets({ raw: 'vercel,vercel' }), {
    vercel: true,
    railway: false,
    targets: 'vercel',
  });
});
