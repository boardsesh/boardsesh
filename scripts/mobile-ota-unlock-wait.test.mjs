import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import {
  dispatchAndWaitForUnlock,
  requireUnlockJobSuccess,
  UNLOCK_WORKFLOW_PATH,
  unlockRunTitle,
  validateUnlockInputs,
  validateUnlockRun,
} from './mobile-ota-unlock-wait.mjs';

const repository = 'boardsesh/boardsesh';
const requestId = '01234567-0123-4567-89ab-0123456789ab';
const headSha = 'a'.repeat(40);
const options = { repository, token: 'test-token', iosRuntime: headSha, androidRuntime: 'b'.repeat(40) };
const workflow = { id: 9, path: UNLOCK_WORKFLOW_PATH, state: 'active' };
const completedRun = {
  id: 25,
  workflow_id: 9,
  path: UNLOCK_WORKFLOW_PATH,
  event: 'workflow_dispatch',
  head_branch: 'main',
  repository: { full_name: repository },
  head_repository: { full_name: repository },
  head_sha: headSha,
  display_title: unlockRunTitle(requestId),
  run_attempt: 1,
  status: 'completed',
  conclusion: 'success',
};
const completedJob = {
  name: 'revert',
  run_id: 25,
  run_attempt: 1,
  status: 'completed',
  conclusion: 'success',
  steps: [{ name: 'Revert the live rollouts', status: 'completed', conclusion: 'success' }],
};

function harness(responses, extra = {}) {
  let milliseconds = 0;
  const calls = [];
  return {
    calls,
    dependencies: {
      requestId,
      now: () => milliseconds,
      sleep: async (duration) => {
        milliseconds += duration;
      },
      log: () => {},
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        const next = responses.shift();
        if (next instanceof Error) throw next;
        if (next === undefined) throw new Error('Unexpected fetch');
        return next;
      },
      ...extra,
    },
  };
}
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const dispatchAccepted = () => json(null, 204);
const runList = (runs) => json({ workflow_runs: runs });

void test('dispatches only main with unique request correlation and both exact runtimes', async () => {
  const { calls, dependencies } = harness([
    json(workflow),
    dispatchAccepted(),
    runList([completedRun]),
    json({ jobs: [completedJob] }),
  ]);
  assert.deepEqual(await dispatchAndWaitForUnlock(options, dependencies), { requestId, runId: 25, headSha });
  assert.equal(calls[1].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    ref: 'main',
    inputs: {
      branch: 'production',
      ios_runtime_version: headSha,
      android_runtime_version: 'b'.repeat(40),
      request_id: requestId,
    },
  });
  assert.match(calls.at(-1).url, /\/actions\/runs\/25\/attempts\/1\/jobs\?per_page=100$/);
  assert.ok(calls.every((call) => call.init.signal instanceof AbortSignal));
});

void test('ignores unrelated successful dispatches and waits for its exact run and job', async () => {
  const running = { ...completedRun, status: 'in_progress', conclusion: null };
  const { calls, dependencies } = harness([
    json(workflow),
    dispatchAccepted(),
    runList([{ ...completedRun, display_title: 'someone else' }]),
    runList([running]),
    json(completedRun),
    json({ jobs: [completedJob] }),
  ]);
  await dispatchAndWaitForUnlock(options, dependencies);
  assert.match(calls[4].url, /\/actions\/runs\/25$/);
  assert.equal(calls.filter((call) => call.init.method === 'POST').length, 1);
});

void test('fails if no matching dispatch appears before the bounded deadline', async () => {
  const { dependencies } = harness([json(workflow), dispatchAccepted(), runList([])], { waitBudgetMs: 10_000 });
  await assert.rejects(dispatchAndWaitForUnlock(options, dependencies), /Timed out/);
});

void test('fails if the exact dispatch remains queued beyond its budget', async () => {
  const queued = { ...completedRun, status: 'queued', conclusion: null };
  const { dependencies } = harness([json(workflow), dispatchAccepted(), runList([queued])], { waitBudgetMs: 10_000 });
  await assert.rejects(dispatchAndWaitForUnlock(options, dependencies), /Timed out/);
});

void test('fails closed on wrong main ref, source, event, workflow, attempt or pinned identity', () => {
  const identity = { repository, workflowId: workflow.id, requestId };
  for (const change of [
    { head_branch: 'release/next' },
    { event: 'push' },
    { workflow_id: 123 },
    { path: '.github/workflows/other.yml' },
    { head_repository: { full_name: 'fork/boardsesh' } },
    { repository: { full_name: 'fork/boardsesh' } },
    { run_attempt: 2 },
    { head_sha: 'short' },
    { display_title: 'Manual OTA unlock' },
  ])
    assert.throws(() => validateUnlockRun({ ...completedRun, ...change }, identity), /trusted main dispatch/);
  assert.throws(() => validateUnlockRun(completedRun, { ...identity, expectedRunId: 123 }), /trusted main dispatch/);
  assert.throws(
    () => validateUnlockRun(completedRun, { ...identity, expectedHeadSha: 'b'.repeat(40) }),
    /trusted main dispatch/,
  );
});

void test('failed, cancelled, skipped and timed-out unlock runs never authorize publication', async () => {
  for (const conclusion of ['failure', 'cancelled', 'skipped', 'timed_out', 'neutral', null]) {
    const { dependencies } = harness([json(workflow), dispatchAccepted(), runList([{ ...completedRun, conclusion }])]);
    await assert.rejects(dispatchAndWaitForUnlock(options, dependencies), /did not succeed/);
  }
});

void test('a green run with missing, skipped or failed revert evidence never authorizes publication', () => {
  assert.throws(() => requireUnlockJobSuccess([], 25), /exactly one/);
  assert.throws(() => requireUnlockJobSuccess([completedJob, completedJob], 25), /exactly one/);
  for (const conclusion of ['skipped', 'failure', 'cancelled', null]) {
    assert.throws(() => requireUnlockJobSuccess([{ ...completedJob, conclusion }], 25), /did not succeed/);
    assert.throws(
      () =>
        requireUnlockJobSuccess(
          [
            {
              ...completedJob,
              steps: [{ ...completedJob.steps[0], conclusion }],
            },
          ],
          25,
        ),
      /did not succeed/,
    );
  }
  assert.throws(() => requireUnlockJobSuccess([{ ...completedJob, run_id: 99 }], 25), /did not succeed/);
  assert.throws(() => requireUnlockJobSuccess([{ ...completedJob, steps: [] }], 25), /did not succeed/);
});

void test('bounded transient reads can recover without redispatching', async () => {
  const { calls, dependencies } = harness([
    json(workflow),
    dispatchAccepted(),
    new Error('temporary 503'),
    runList([completedRun]),
    json({ jobs: [completedJob] }),
  ]);
  await dispatchAndWaitForUnlock(options, dependencies);
  assert.equal(calls.filter((call) => call.init.method === 'POST').length, 1);
});

void test('persistent unreadable status and duplicate correlation fail closed', async () => {
  const { dependencies } = harness([
    json(workflow),
    dispatchAccepted(),
    ...Array.from({ length: 5 }, () => new Error('unreadable')),
  ]);
  await assert.rejects(dispatchAndWaitForUnlock(options, dependencies), /unreadable/);
  const duplicate = harness([json(workflow), dispatchAccepted(), runList([completedRun, completedRun])]);
  await assert.rejects(dispatchAndWaitForUnlock(options, duplicate.dependencies), /Multiple runs/);
});

void test('an accepted-but-stalled dispatch request times out and is never repeated', async () => {
  let calls = 0;
  const { dependencies } = harness([], {
    requestTimeoutMs: 5,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? json(workflow) : new Promise(() => {});
    },
  });
  await assert.rejects(dispatchAndWaitForUnlock(options, dependencies), /request timed out/);
  assert.equal(calls, 2);
});

void test('requires full runtime fingerprints and rejects empty or unsafe dispatch inputs', () => {
  assert.doesNotThrow(() => validateUnlockInputs(options));
  for (const change of [
    { repository: '../evil' },
    { token: '' },
    { iosRuntime: '', androidRuntime: '' },
    { iosRuntime: 'a'.repeat(12) },
    { branch: 'production\nunsafe' },
  ])
    assert.throws(() => validateUnlockInputs({ ...options, ...change }));
  assert.throws(() => unlockRunTitle('untrusted\nname'));
});

void test('publisher workflows hold the lane, await unlock, and never unlock staging', () => {
  const production = parse(
    readFileSync(new URL('../.github/workflows/mobile-ota-production.yml', import.meta.url), 'utf8'),
  );
  const backport = parse(
    readFileSync(new URL('../.github/workflows/mobile-ota-backport.yml', import.meta.url), 'utf8'),
  );
  const unlock = parse(readFileSync(new URL('../.github/workflows/mobile-ota-unlock.yml', import.meta.url), 'utf8'));
  assert.equal(production.jobs.publish.permissions.actions, 'write');
  assert.equal(backport.jobs.backport.permissions.actions, 'write');
  assert.equal(unlock.permissions.contents, 'read');
  assert.equal(unlock.concurrency, undefined);
  assert.equal(unlock.jobs.revert.environment, 'ota-stable-release');
  assert.equal(unlock.jobs.revert.steps.find((step) => step.name === 'Checkout main').with.ref, 'main');
  assert.ok(unlock['run-name'].includes('inputs.request_id'));
  const revert = unlock.jobs.revert.steps.find((step) => step.name === 'Revert the live rollouts');
  assert.ok(revert.run.includes('Automatic unlock requires OTA_ADMIN_EMAIL'));
  assert.ok(revert.run.includes('--platform "$platform"'));
  assert.ok(!revert.run.includes(' rollout.ts finish '));
  const steps = production.jobs.publish.steps;
  const wait = steps.find((step) => step.id === 'unlock');
  assert.ok(wait.if.includes('!inputs.stage_for_production_deploy'));
  assert.ok(steps.findIndex((step) => step.id === 'unlock_runtimes') < steps.findIndex((step) => step.id === 'unlock'));
  for (const platform of ['ios', 'android']) {
    const publish = steps.find((step) => step.id === `publish_${platform}`);
    assert.ok(publish.if.includes("inputs.stage_for_production_deploy || steps.unlock.outcome == 'success'"));
    assert.ok(publish.if.includes(`steps.train_guard.outputs.publish_${platform} != 'false'`));
    assert.ok(steps.indexOf(wait) < steps.indexOf(publish));
  }
  const backportSteps = backport.jobs.backport.steps;
  const publish = backportSteps.find((step) => step.id === 'publish');
  assert.ok(publish.if.includes("steps.unlock.outcome == 'success'"));
  const snapshot = backportSteps.find((step) => step.name === 'Snapshot trusted OTA publish tooling');
  assert.ok(snapshot.run.includes('scripts/mobile-ota-unlock-wait.mjs'));
  assert.ok(backportSteps.find((step) => step.id === 'unlock').run.includes('$RUNNER_TEMP/ota-publish-tooling'));
});
