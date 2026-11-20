import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  deploymentRequest,
  dispatchAndWait,
  matchingReceiverRun,
  preflightRailwayHosting,
  validateReceipt,
} from './ota-server-deploy.mjs';
import { HOMELAB_APPLY_PATHS, otaDeployment, parseOtaHosting } from './lib/ota-hosting.mjs';
import { expectsOtaDeployment } from './mobile-ota-server-ready.mjs';

const release = {
  version: '3.2.6',
  repository: 'ghcr.io/mercuretechnologies/expo-open-ota',
  digest: `sha256:${'a'.repeat(64)}`,
};
const env = {
  GITHUB_REF: 'refs/heads/main',
  GITHUB_REPOSITORY: 'boardsesh/boardsesh',
  GITHUB_SHA: 'b'.repeat(40),
  GITHUB_RUN_ID: '1234',
  GITHUB_RUN_ATTEMPT: '2',
  HOMELAB_DEPLOY_ENABLED: 'true',
  HOMELAB_DISPATCH_TOKEN: 'fixture-token',
};
const request = deploymentRequest(release, env);
const run = {
  id: 42,
  display_title: 'Boardsesh OTA 1234-2',
  event: 'repository_dispatch',
  head_branch: 'main',
  status: 'completed',
  conclusion: 'success',
};
const receipt = { ...request, receiver_run_id: 42, status: 'verified' };

await test('Railway preflight reads both private Actions endpoints and never dispatches', async () => {
  const calls = [];
  const logs = [];
  assert.equal(
    await preflightRailwayHosting(env, {
      callApi: async (path, token, options) => {
        calls.push({ path, token, options });
        return { json: async () => (path.includes('/workflows/') ? { workflow_runs: [] } : { artifacts: [] }) };
      },
      log: (message) => logs.push(message),
    }),
    true,
  );
  assert.deepEqual(calls, [
    {
      path: '/actions/workflows/boardsesh-ota-deploy.yml/runs?branch=main&per_page=1',
      token: env.HOMELAB_DISPATCH_TOKEN,
      options: { method: 'GET' },
    },
    { path: '/actions/artifacts?per_page=1', token: env.HOMELAB_DISPATCH_TOKEN, options: { method: 'GET' } },
  ]);
  assert.match(logs.at(-1), /preflight passed.*No deployment dispatched/);
  assert.ok(logs.every((message) => !message.includes(env.HOMELAB_DISPATCH_TOKEN)));
});

await test('disabled Railway preflight makes no API call and does not claim credential verification', async () => {
  const logs = [];
  const checked = await preflightRailwayHosting(
    { ...env, HOMELAB_DEPLOY_ENABLED: 'false', HOMELAB_DISPATCH_TOKEN: '' },
    {
      callApi: async () => {
        throw new Error('unexpected request');
      },
      log: (message) => logs.push(message),
    },
  );
  assert.equal(checked, false);
  assert.match(logs.at(-1), /preflight not run/);
  assert.ok(logs.every((message) => !message.includes('preflight passed')));
});

await test('Railway preflight rejects missing credentials and foreign contexts before any API call', async () => {
  let calls = 0;
  for (const patch of [
    { HOMELAB_DISPATCH_TOKEN: '' },
    { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_REPOSITORY: 'fork/boardsesh' },
  ]) {
    await assert.rejects(
      preflightRailwayHosting(
        { ...env, ...patch },
        {
          callApi: async () => {
            calls++;
          },
          log: () => {},
        },
      ),
    );
  }
  assert.equal(calls, 0);
});

await test('both preflight reads must succeed; permission errors expose only a safe status', async () => {
  for (const refused of ['/workflows/', '/artifacts']) {
    const logs = [];
    await assert.rejects(
      preflightRailwayHosting(env, {
        callApi: async (path) => {
          if (path.includes(refused))
            throw new Error(`GitHub API HTTP 403 for ${path}: private body ${env.HOMELAB_DISPATCH_TOKEN}`);
          return { json: async () => ({ workflow_runs: [] }) };
        },
        log: (message) => logs.push(message),
      }),
      (error) =>
        /HTTP 403/.test(error.message) &&
        /Actions: read/.test(error.message) &&
        !error.message.includes(env.HOMELAB_DISPATCH_TOKEN) &&
        !error.message.includes('private body'),
    );
    assert.ok(logs.every((message) => !message.includes('preflight passed')));
  }
});

await test('malformed list and transport responses cannot pass the credential preflight', async () => {
  for (const field of ['workflow_runs', 'artifacts']) {
    await assert.rejects(
      preflightRailwayHosting(env, {
        callApi: async () => ({ json: async () => ({ workflow_runs: [], artifacts: [], [field]: null }) }),
        log: () => {},
      }),
      /invalid/,
    );
  }
  await assert.rejects(
    preflightRailwayHosting(env, {
      callApi: async () => {
        throw new Error(env.HOMELAB_DISPATCH_TOKEN);
      },
      log: () => {},
    }),
    (error) => /preflight could not read/.test(error.message) && !error.message.includes(env.HOMELAB_DISPATCH_TOKEN),
  );
});

await test('request binds main source, version and digest to a unique sender attempt', () => {
  assert.equal(request.request_id, '1234-2');
  assert.equal(request.source_sha, env.GITHUB_SHA);
  assert.equal(request.digest, release.digest);
  assert.equal(request.source_run_url, 'https://github.com/boardsesh/boardsesh/actions/runs/1234');
});

await test('disabled deployment, missing credential, foreign repo and non-main refs fail closed', () => {
  for (const patch of [
    { HOMELAB_DEPLOY_ENABLED: 'false' },
    { HOMELAB_DISPATCH_TOKEN: '' },
    { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_REPOSITORY: 'fork/boardsesh' },
    { GITHUB_SHA: 'short' },
    { GITHUB_RUN_ATTEMPT: '0' },
  ]) {
    assert.throws(() => deploymentRequest(release, { ...env, ...patch }));
  }
  assert.throws(() => deploymentRequest({ ...release, digest: 'latest' }, env));
});

await test('an unrelated latest success or manual run is never the acknowledgment', () => {
  assert.equal(matchingReceiverRun([{ ...run, display_title: 'Boardsesh OTA 1234-1' }], request), null);
  assert.equal(matchingReceiverRun([{ ...run, event: 'workflow_dispatch' }], request), null);
  assert.equal(matchingReceiverRun([{ ...run, head_branch: 'feature' }], request), null);
  assert.throws(() => matchingReceiverRun([run, { ...run, id: 43 }], request), /Multiple/);
  assert.equal(matchingReceiverRun([run], request), run);
});

await test('receipt must match every identity field and the successful receiver', () => {
  assert.equal(validateReceipt(receipt, request, 42), receipt);
  for (const field of ['request_id', 'source_sha', 'version', 'digest', 'receiver_run_id', 'status']) {
    assert.throws(() => validateReceipt({ ...receipt, [field]: 'wrong' }, request, 42));
  }
});

function harness(runs, readReceipt = async () => receipt) {
  let clock = 0;
  const calls = [];
  const dependencies = {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    callApi: async (path, _token, options) => {
      calls.push({ path, options });
      return { json: async () => ({ workflow_runs: runs() }) };
    },
    readReceipt,
  };
  return { dependencies, calls };
}

await test('dispatch acceptance alone never succeeds; missing receiver times out', async () => {
  const { dependencies } = harness(() => []);
  await assert.rejects(dispatchAndWait(request, 'token', dependencies), /never appeared/);
});

await test('successful receiver still needs a matching verified receipt', async () => {
  const { dependencies, calls } = harness(() => [run]);
  assert.deepEqual(await dispatchAndWait(request, 'token', dependencies), receipt);
  assert.deepEqual(JSON.parse(calls[0].options.body), { event_type: 'boardsesh-ota-release', client_payload: request });
  const missing = harness(
    () => [run],
    async () => {
      throw new Error('no receipt');
    },
  );
  await assert.rejects(dispatchAndWait(request, 'token', missing.dependencies), /no receipt/);
  const mismatched = harness(
    () => [run],
    async () => ({ ...receipt, digest: `sha256:${'c'.repeat(64)}` }),
  );
  await assert.rejects(dispatchAndWait(request, 'token', mismatched.dependencies), /digest/);
});

await test('failed, cancelled, timed-out and skipped receiver runs block publishing', async () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped', null]) {
    const { dependencies } = harness(() => [{ ...run, conclusion }]);
    await assert.rejects(dispatchAndWait(request, 'token', dependencies), /ended with/);
  }
});

await test('running receiver is waited for, without accepting an old unrelated success', async () => {
  let polls = 0;
  const { dependencies } = harness(() =>
    ++polls === 1
      ? [
          { ...run, status: 'in_progress', conclusion: null },
          { ...run, id: 41, display_title: 'Boardsesh OTA 1233-1' },
        ]
      : [run],
  );
  assert.deepEqual(await dispatchAndWait(request, 'token', dependencies), receipt);
  assert.equal(polls, 2);
});

await test('hosting selects the exact deployment gate and unknown providers are rejected', () => {
  assert.equal(otaDeployment('railway').workflow, 'railway-drift.yml');
  assert.equal(otaDeployment('homelab').workflow, 'ota-server-deploy.yml');
  assert.throws(() => parseOtaHosting({ provider: 'unknown' }));
  assert.equal(
    expectsOtaDeployment({ provider: 'homelab', ref: 'refs/heads/main', changedFiles: ['infra/ota/server.json'] }),
    true,
  );
  assert.equal(
    expectsOtaDeployment({ provider: 'homelab', ref: 'refs/heads/feature', changedFiles: ['infra/ota/server.json'] }),
    false,
  );
  assert.equal(
    expectsOtaDeployment({ provider: 'homelab', ref: 'refs/heads/main', changedFiles: ['infra/railway/config.ts'] }),
    false,
  );
});

await test('sender push triggers exactly match the publishing gate paths', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ota-server-deploy.yml', import.meta.url), 'utf8');
  const paths = [
    ...workflow
      .slice(workflow.indexOf('    paths:'), workflow.indexOf('  workflow_dispatch:'))
      .matchAll(/- '([^']+)'/g),
  ].map((match) => match[1]);
  assert.deepEqual(paths, HOMELAB_APPLY_PATHS);
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /environment: Homelab/);
  assert.doesNotMatch(workflow, /pull_request:|cancel-in-progress: true/);
});
