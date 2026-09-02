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
const RAILWAY_TARGET = {
  railway: true,
  targets: 'railway',
  railwayServiceId: SERVICE_ID,
  railwayOrigin: RAILWAY_ORIGIN,
};
const HELD_TARGET = {
  railway: false,
  targets: 'none',
  railwayServiceId: '',
  railwayOrigin: '',
};

/** Resolve with the Railway identity filled in, collecting any warnings. */
function resolveRailway(raw, overrides = {}) {
  const warnings = [];
  const resolved = resolveWebDeployTargets({
    raw,
    railwayWebServiceId: SERVICE_ID,
    railwayWebOrigin: RAILWAY_ORIGIN,
    warn: (message) => warnings.push(message),
    ...overrides,
  });
  return { resolved, warnings };
}

void test('an unset variable deploys www to Railway', () => {
  for (const raw of [undefined, '', '   ']) {
    assert.deepEqual(resolveRailway(raw).resolved, RAILWAY_TARGET, String(raw));
  }
});

void test('resolves the railway target, with whitespace and casing tolerated', () => {
  for (const raw of ['railway', ' railway ', 'RAILWAY', '\trailway\t']) {
    assert.deepEqual(resolveRailway(raw).resolved, RAILWAY_TARGET, raw);
  }
});

void test('a retired vercel entry is ignored with a warning, never a failure', () => {
  // The merge-order property. When the Vercel scrub landed the live value was
  // `vercel,railway`, and the workflow and the variable are changed by
  // different people at different times. A resolver that threw on the stale
  // value would have failed resolve-web-targets and skipped EVERY web deploy
  // until somebody noticed — so the retired name resolves, loudly.
  for (const raw of ['vercel,railway', 'railway,vercel', ' Vercel , RAILWAY ', 'vercel,\trailway']) {
    const { resolved, warnings } = resolveRailway(raw);
    assert.deepEqual(resolved, RAILWAY_TARGET, raw);
    assert.equal(warnings.length, 1, raw);
    assert.match(warnings[0], /"vercel".*retired/, raw);
  }
});

void test('a variable naming ONLY a retired target still deploys www', () => {
  // `vercel` alone meant "deploy www". Railway is now the only way to do that,
  // so honouring the intent beats an accidental hold nobody asked for.
  const { resolved, warnings } = resolveRailway('vercel');
  assert.deepEqual(resolved, RAILWAY_TARGET);
  assert.equal(warnings.length, 1);
});

void test('a run with no retired target warns about nothing', () => {
  for (const raw of ['railway', '', 'none']) {
    assert.deepEqual(resolveRailway(raw).warnings, [], raw);
  }
});

void test('resolving without a warn callback does not throw', () => {
  // runCli always passes one, but the export is public and the optional-call
  // is easy to regress into `warn(...)`.
  assert.deepEqual(
    resolveWebDeployTargets({
      raw: 'vercel,railway',
      railwayWebServiceId: SERVICE_ID,
      railwayWebOrigin: RAILWAY_ORIGIN,
    }),
    RAILWAY_TARGET,
  );
});

void test('"none" is the web hold', () => {
  assert.deepEqual(resolveWebDeployTargets({ raw: 'none' }), HELD_TARGET);
  assert.deepEqual(resolveWebDeployTargets({ raw: ' NONE ' }), HELD_TARGET);
});

void test('rejects an unknown target rather than silently deploying nothing', () => {
  // The failure this prevents: a typo like `verel` resolving to "no targets",
  // which looks exactly like a deliberate hold in the run summary.
  assert.throws(() => resolveWebDeployTargets({ raw: 'verel' }), /unknown target/);
  assert.throws(() => resolveWebDeployTargets({ raw: 'railwya' }), /unknown target/);
  assert.throws(() => resolveWebDeployTargets({ raw: 'true' }), /unknown target/);
  // Dropping the retired name must not swallow a real typo beside it.
  assert.throws(() => resolveWebDeployTargets({ raw: 'vercel,cloudflare' }), /unknown target/);
});

void test('rejects "none" mixed with a real target', () => {
  assert.throws(() => resolveWebDeployTargets({ raw: 'none,railway' }), /cannot be combined/);
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
  // The retired name is dropped before validation, so it cannot mask a
  // missing Railway identity.
  assert.throws(() => resolveWebDeployTargets({ raw: 'vercel,railway' }), /RAILWAY_WEB_SERVICE_ID/);
  assert.throws(() => resolveWebDeployTargets({ raw: 'vercel' }), /RAILWAY_WEB_SERVICE_ID/);
});

void test('a missing service id never blocks a held run', () => {
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

void test('a missing smoke origin never blocks a held run', () => {
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

void test('rejects separator-only and empty target entries instead of defaulting', () => {
  for (const raw of [',', ',,', ' , ', 'railway,', ',railway', 'vercel,,railway']) {
    assert.throws(
      () => resolveWebDeployTargets({ raw, railwayWebServiceId: SERVICE_ID, railwayWebOrigin: RAILWAY_ORIGIN }),
      /empty target/,
      raw,
    );
  }
});

void test('duplicate entries collapse to the canonical set', () => {
  assert.deepEqual(resolveRailway('railway,railway').resolved, RAILWAY_TARGET);
  assert.deepEqual(resolveRailway('vercel,vercel,railway').resolved, RAILWAY_TARGET);
});

void test('publishes the validated Railway identity under the workflow output names', () => {
  assert.equal(
    formatGithubOutputs(RAILWAY_TARGET),
    [
      'web_railway=true',
      'web_targets=railway',
      `web_railway_service_id=${SERVICE_ID}`,
      `web_railway_origin=${RAILWAY_ORIGIN}`,
      '',
    ].join('\n'),
  );
});

void test('rejects multiline GitHub output values instead of creating forged output entries', () => {
  assert.throws(
    () =>
      formatGithubOutputs({
        ...RAILWAY_TARGET,
        railwayOrigin: `${RAILWAY_ORIGIN}\nforged_output=true`,
      }),
    /web_railway_origin must be a single-line GitHub output/,
  );
});

void test('escapes operator-controlled text before emitting a GitHub workflow command', () => {
  assert.equal(workflowCommandValue('railway\n::error::forged%line\r'), 'railway%0A::error::forged%25line%0D');
});
