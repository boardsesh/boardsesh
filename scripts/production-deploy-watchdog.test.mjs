import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';
import {
  CANCEL_GRACE_MS,
  DEFAULT_MAX_RUN_MINUTES,
  DEFAULT_STALL_MINUTES,
  FORCE_CONFIRM_MS,
  LANES,
  MOBILE_OTA_LANE,
  PRODUCTION_DEPLOY_LANE,
  cancelAndConfirm,
  createCliGitHub,
  DISCORD_CONTENT_LIMIT,
  classifyRun,
  formatDiscordContent,
  formatDuration,
  formatSummary,
  isParked,
  laneRules,
  parseCliArguments,
  parseRepublishRunName,
  planWatchdogActions,
  redispatchEnabledFrom,
  runCli,
  STALE_EVIDENCE_STEP,
  decideRepublish,
  decideTipRecovery,
} from './production-deploy-watchdog.mjs';

const NOW = Date.parse('2026-08-21T12:00:00Z');
const HEAD_SHA = '2222222222222222222222222222222222222222';

function minutesAgo(minutes) {
  return new Date(NOW - minutes * 60_000).toISOString();
}

function run(overrides = {}) {
  return {
    id: 1,
    run_number: 100,
    status: 'waiting',
    conclusion: null,
    event: 'push',
    head_sha: '1111111111111111111111111111111111111111',
    created_at: minutesAgo(90),
    run_started_at: minutesAgo(90),
    updated_at: minutesAgo(90),
    ...overrides,
  };
}

void test('cancels a run parked past the stall threshold even after some jobs completed', () => {
  // The August 2026 wedge: detect-changes and deploy-app-web finished, then
  // check-rollback sat on the Production environment gate for two days.
  //
  // `check-rollback` no longer exists — it went with the Vercel scrub — but the
  // name is kept here because it is the incident this test reproduces, and
  // classifyRun treats job names as opaque. Any job declaring
  // `environment: Production` can still wedge the group the same way.
  const verdict = classifyRun({
    run: run(),
    jobs: [
      { name: 'detect-changes', status: 'completed' },
      { name: 'deploy-app-web', status: 'completed' },
      { name: 'check-rollback', status: 'waiting' },
    ],
    nowMs: NOW,
  });

  assert.equal(verdict.action, 'cancel');
  assert.match(verdict.reason, /no job executing/);
});

void test('leaves a parked run alone until it crosses the stall threshold', () => {
  const verdict = classifyRun({
    run: run({ run_started_at: minutesAgo(DEFAULT_STALL_MINUTES - 5) }),
    jobs: [{ name: 'check-rollback', status: 'queued' }],
    nowMs: NOW,
  });

  assert.equal(verdict.action, 'none');
});

void test('cancels an executing run after the six-hour maximum', () => {
  const verdict = classifyRun({
    run: run({ status: 'in_progress', run_started_at: minutesAgo(60 * 24), updated_at: minutesAgo(60 * 24) }),
    jobs: [
      { name: 'migrate', status: 'completed' },
      { name: 'deploy-web', status: 'in_progress' },
    ],
    nowMs: NOW,
  });

  assert.equal(verdict.action, 'cancel');
});

void test('a busy deploy inside the alert window needs no action', () => {
  const verdict = classifyRun({
    run: run({ status: 'in_progress', run_started_at: minutesAgo(6), updated_at: minutesAgo(1) }),
    jobs: [{ name: 'build-web', status: 'in_progress' }],
    nowMs: NOW,
  });

  assert.equal(verdict.action, 'none');
});

void test('a pending run is never a target — it is the run being freed', () => {
  // GitHub reports a run queued behind the concurrency group as `pending`.
  // Cancelling it would throw away the very deploy the watchdog exists to let
  // through.
  const verdict = classifyRun({ run: run({ status: 'pending' }), jobs: [], nowMs: NOW });

  assert.equal(verdict.action, 'none');
});

void test('a completed run is never a target', () => {
  const verdict = classifyRun({
    run: run({ status: 'completed', conclusion: 'success' }),
    jobs: [{ name: 'deploy-web', status: 'completed' }],
    nowMs: NOW,
  });

  assert.equal(verdict.action, 'none');
});

void test('a waiting run with no job list yet reads as parked', () => {
  // `waiting` is GitHub's word for "held by an environment gate", so it is
  // parked whether or not any job has materialised. `queued` is not: it means
  // waiting on a runner, which resolves itself, so with no job list to prove
  // otherwise it stays a candidate for the age-based alert rather than a cancel.
  assert.equal(isParked(run({ status: 'waiting' }), []), true);
  assert.equal(isParked(run({ status: 'queued' }), []), false);
});

void test('a job list that includes an executing job is never parked', () => {
  // The pagination guard in listJobs exists for this: drop the page holding the
  // one in_progress job and a working deploy would read as parked.
  const jobs = Array.from({ length: 60 }, (_, index) => ({
    name: `job-${index}`,
    status: index === 55 ? 'in_progress' : 'completed',
  }));

  assert.equal(isParked(run({ status: 'in_progress' }), jobs), false);
});

void test('unreadable timestamps produce no action rather than a blind cancel', () => {
  const verdict = classifyRun({
    run: run({ created_at: 'not-a-date', run_started_at: undefined, updated_at: undefined }),
    jobs: [{ name: 'check-rollback', status: 'waiting' }],
    nowMs: NOW,
  });

  assert.equal(verdict.action, 'none');
});

void test('durations read as time, not as a minute count', () => {
  assert.equal(formatDuration(45), '45m');
  assert.equal(formatDuration(60), '1h');
  assert.equal(formatDuration(90), '1h 30m');
  assert.equal(formatDuration(60 * 24), '1d');
  assert.equal(formatDuration(60 * 49), '2d 1h');
});

void test('does not redispatch when a queued run will take over the freed group', () => {
  const plan = planWatchdogActions({
    runs: [
      run({ id: 2, run_number: 101, status: 'pending', head_sha: HEAD_SHA }),
      run({ id: 1, run_number: 100, status: 'waiting' }),
    ],
    jobsByRunId: { 1: [{ name: 'check-rollback', status: 'waiting' }] },
    headSha: HEAD_SHA,
    nowMs: NOW,
  });

  assert.deepEqual(
    plan.cancel.map((entry) => entry.run.id),
    [1],
  );
  assert.equal(plan.redispatch, false);
});

void test('redispatches when cancelling empties the group', () => {
  const plan = planWatchdogActions({
    runs: [run({ id: 1, status: 'waiting', head_sha: HEAD_SHA })],
    jobsByRunId: { 1: [{ name: 'check-rollback', status: 'waiting' }] },
    headSha: HEAD_SHA,
    nowMs: NOW,
  });

  assert.equal(plan.redispatch, true);
});

void test('spends only one redispatch per head sha, so a broken gate cannot loop', () => {
  const plan = planWatchdogActions({
    runs: [
      run({ id: 2, status: 'waiting', event: 'workflow_dispatch', head_sha: HEAD_SHA }),
      run({ id: 1, status: 'waiting', head_sha: HEAD_SHA }),
    ],
    jobsByRunId: {
      1: [{ name: 'check-rollback', status: 'waiting' }],
      2: [{ name: 'check-rollback', status: 'waiting' }],
    },
    headSha: HEAD_SHA,
    nowMs: NOW,
  });

  assert.equal(plan.cancel.length, 2);
  assert.equal(plan.redispatch, false);
});

void test('does not redispatch a head that already deployed successfully', () => {
  const plan = planWatchdogActions({
    runs: [
      run({ id: 2, status: 'completed', conclusion: 'success', head_sha: HEAD_SHA }),
      run({ id: 1, status: 'waiting' }),
    ],
    jobsByRunId: { 1: [{ name: 'check-rollback', status: 'waiting' }] },
    headSha: HEAD_SHA,
    nowMs: NOW,
  });

  assert.equal(plan.cancel.length, 1);
  assert.equal(plan.redispatch, false);
});

void test('a quiet tick plans nothing and says so', () => {
  const plan = planWatchdogActions({
    runs: [run({ id: 1, status: 'completed', conclusion: 'success' })],
    headSha: HEAD_SHA,
    nowMs: NOW,
  });

  assert.deepEqual(plan, { cancel: [], alert: [], redispatch: false, followUp: 'none', recoveringCancelledRun: false });
  assert.equal(formatSummary(plan), 'no stalled production deploy found');
  assert.equal(formatDiscordContent(plan), '');
});

void test('says main is not deploying when nothing is queued and the retry is spent', () => {
  // The worst possible report: free the group, then announce a recovery that is
  // not happening. Retry spent by an earlier dispatch, no survivor behind it.
  const plan = planWatchdogActions({
    runs: [
      run({ id: 2, status: 'waiting', event: 'workflow_dispatch', head_sha: HEAD_SHA }),
      run({ id: 1, status: 'waiting', head_sha: HEAD_SHA }),
    ],
    jobsByRunId: {
      1: [{ name: 'check-rollback', status: 'waiting' }],
      2: [{ name: 'check-rollback', status: 'waiting' }],
    },
    headSha: HEAD_SHA,
    nowMs: NOW,
  });

  assert.equal(plan.redispatch, false);
  assert.equal(plan.followUp, 'needs-intervention');

  const content = formatDiscordContent(plan);
  assert.match(content, /main is NOT deploying/);
  assert.doesNotMatch(content, /queued run behind it/);
  // allowed_mentions.parse=[] blocks pings, so never write one.
  assert.doesNotMatch(content, /@here|@everyone/);
  assert.match(formatSummary(plan), /needs a human/);
});

void test('a freed group with a queued successor reports the successor, not a dispatch', () => {
  const plan = planWatchdogActions({
    runs: [run({ id: 2, status: 'pending', head_sha: HEAD_SHA }), run({ id: 1, status: 'waiting' })],
    jobsByRunId: { 1: [{ name: 'check-rollback', status: 'waiting' }] },
    headSha: HEAD_SHA,
    nowMs: NOW,
  });

  assert.equal(plan.followUp, 'queued-run-takes-over');
  assert.match(formatDiscordContent(plan), /queued or active deploy remains/);
});

void test('a head that already deployed is not an intervention', () => {
  const plan = planWatchdogActions({
    runs: [
      run({ id: 2, status: 'completed', conclusion: 'success', head_sha: HEAD_SHA }),
      run({ id: 1, status: 'waiting' }),
    ],
    jobsByRunId: { 1: [{ name: 'check-rollback', status: 'waiting' }] },
    headSha: HEAD_SHA,
    nowMs: NOW,
  });

  assert.equal(plan.followUp, 'head-already-deployed');
  assert.match(formatDiscordContent(plan), /already deployed successfully/);
});

void test('the Discord message names the run, the cause and the gate to check', () => {
  const plan = planWatchdogActions({
    runs: [run({ id: 42, run_number: 1337, status: 'waiting', head_sha: HEAD_SHA })],
    jobsByRunId: { 42: [{ name: 'check-rollback', status: 'waiting' }] },
    headSha: HEAD_SHA,
    nowMs: NOW,
  });
  const content = formatDiscordContent(plan, { runUrlBase: 'https://example.test/actions/runs' });

  assert.match(content, /#1337/);
  assert.match(content, /2222222/);
  assert.match(content, /parked for 1h 30m/);
  assert.match(content, /Production environment protection rules/);
  assert.match(content, /<https:\/\/example\.test\/actions\/runs\/42>/);
});

void test('a Discord message never exceeds the limit that would make the post fail', () => {
  // Many parked runs at once. Over 2000 chars Discord answers 400 and the
  // workflow's best-effort post swallows it — a silent alarm, which is the one
  // outcome this watchdog must never produce.
  const runs = Array.from({ length: 60 }, (_, index) =>
    run({ id: 100 + index, run_number: 1000 + index, status: 'waiting', head_sha: `${index}`.padStart(40, 'a') }),
  );
  const jobsByRunId = Object.fromEntries(
    runs.map((entry) => [entry.id, [{ name: 'check-rollback', status: 'waiting' }]]),
  );
  const plan = planWatchdogActions({ runs, jobsByRunId, headSha: HEAD_SHA, nowMs: NOW });
  const content = formatDiscordContent(plan, { runUrlBase: 'https://example.test/actions/runs' });

  assert.equal(plan.cancel.length, 60);
  assert.ok(content.length <= DISCORD_CONTENT_LIMIT, `content was ${content.length} chars`);
  assert.match(content, /truncated/);
});

void test('one cancel that fails does not strand the others', async () => {
  const cancelled = [];
  const dispatched = [];
  const discordFilePath = join(mkdtempSync(join(tmpdir(), 'boardsesh-watchdog-')), 'discord.txt');

  const result = await runCli({
    github: {
      listRuns: () => ({
        runs: [
          run({ id: 1, status: 'waiting', head_sha: HEAD_SHA }),
          run({ id: 2, status: 'waiting', head_sha: HEAD_SHA }),
        ],
        recentPageOk: true,
      }),
      listJobs: () => [{ name: 'check-rollback', status: 'waiting' }],
      getRun: (runId) => run({ id: runId, status: cancelled.includes(runId) ? 'completed' : 'waiting' }),
      cancelRun: (runId) => {
        // A rejected API request must not prevent the next run's cancellation.
        if (runId === 1) throw new Error('HTTP 403: cancellation denied');
        cancelled.push(runId);
      },
      dispatchRun: (ref) => dispatched.push(ref),
    },
    headSha: HEAD_SHA,
    nowMs: NOW,
    now: () => NOW,
    runUrlBase: '',
    discordFilePath,
    outputPath: '',
    dryRun: false,
  });

  assert.equal(result.failed, true);
  // The second cancel still happened...
  assert.deepEqual(cancelled, [2]);
  // ...and the retry is left for the next tick, since the group may still be held.
  assert.deepEqual(dispatched, []);
  // ...and crucially the report says so. One cancel DID land here, so the old
  // `cancelled.length > 0` guard let the planned "Dispatched a fresh deploy"
  // line through even though no dispatch fired.
  const content = readFileSync(discordFilePath, 'utf8');
  assert.doesNotMatch(content, /Dispatched a fresh deploy/);
  assert.match(content, /No deploy was started/);
  assert.match(content, /Could NOT cancel run/);
  // One cancel DID land, but the headline follows the worst outcome: a run may
  // still be holding the group, so this must not read as a recovery.
  assert.match(content, /still wedged/);
  assert.doesNotMatch(content, /unwedged/);
});

void test('an unreadable run history withholds the dispatch and says why', async () => {
  const dispatched = [];

  await runCli({
    github: {
      listRuns: () => ({ runs: [run({ id: 1, status: 'waiting', head_sha: HEAD_SHA })], recentPageOk: false }),
      listJobs: () => [{ name: 'check-rollback', status: 'waiting' }],
      getRun: () => run({ status: 'completed' }),
      cancelRun: () => {},
      dispatchRun: (ref) => dispatched.push(ref),
    },
    headSha: HEAD_SHA,
    nowMs: NOW,
    now: () => NOW,
    runUrlBase: '',
    discordFilePath: '',
    outputPath: '',
    dryRun: false,
  });

  // Without the completed runs, the one-retry-per-commit guard cannot be
  // checked, so firing a dispatch would risk the loop the guard exists to stop.
  assert.deepEqual(dispatched, []);
});

void test('the report never claims a cancel that did not land', () => {
  const plan = planWatchdogActions({
    runs: [run({ id: 7, run_number: 1337, status: 'waiting', head_sha: HEAD_SHA })],
    jobsByRunId: { 7: [{ name: 'check-rollback', status: 'waiting' }] },
    headSha: HEAD_SHA,
    nowMs: NOW,
  });
  const failedCancelIds = new Set(['7']);
  const content = formatDiscordContent(plan, { failedCancelIds });

  assert.doesNotMatch(content, /• Cancelled run/);
  assert.match(content, /Could NOT cancel run #1337/);
  // Still wedged, so it must not read as a recovery.
  assert.match(content, /still wedged/);
  assert.doesNotMatch(content, /unwedged/);
  assert.doesNotMatch(content, /queued run behind it/);
  assert.match(formatSummary(plan, { failedCancelIds }), /could NOT cancel/);
});

void test('the CLI cancels, redispatches and reports through one pass', async () => {
  const cancelled = [];
  const dispatched = [];
  const stalled = run({ id: 7, status: 'waiting', head_sha: HEAD_SHA });

  const plan = await runCli({
    github: {
      listRuns: () => ({
        runs: [cancelled.length ? { ...stalled, status: 'completed', conclusion: 'cancelled' } : stalled],
        recentPageOk: true,
      }),
      getRun: () => (cancelled.length ? { ...stalled, status: 'completed' } : stalled),
      listJobs: () => [{ name: 'check-rollback', status: 'waiting' }],
      cancelRun: (runId) => cancelled.push(runId),
      dispatchRun: (ref) => dispatched.push(ref),
    },
    headSha: HEAD_SHA,
    nowMs: NOW,
    now: () => NOW,
    runUrlBase: '',
    discordFilePath: '',
    outputPath: '',
    dryRun: false,
  });

  assert.deepEqual(cancelled, [7]);
  assert.deepEqual(dispatched, ['main']);
  assert.equal(plan.cancel.length, 1);
});

void test('a dry run reports the same plan without touching anything', async () => {
  const cancelled = [];
  const dispatched = [];
  const workDirectory = mkdtempSync(join(tmpdir(), 'boardsesh-watchdog-'));
  const discordFilePath = join(workDirectory, 'discord.txt');
  const outputPath = join(workDirectory, 'github-output.txt');

  const plan = await runCli({
    github: {
      listRuns: () => ({ runs: [run({ id: 7, status: 'waiting', head_sha: HEAD_SHA })], recentPageOk: true }),
      listJobs: () => [{ name: 'check-rollback', status: 'waiting' }],
      cancelRun: (runId) => cancelled.push(runId),
      dispatchRun: (ref) => dispatched.push(ref),
    },
    headSha: HEAD_SHA,
    nowMs: NOW,
    now: () => NOW,
    runUrlBase: '',
    discordFilePath,
    outputPath,
    dryRun: true,
  });

  assert.deepEqual(cancelled, []);
  assert.deepEqual(dispatched, []);
  // It found the same wedge — it just says "would cancel" and stays off Discord,
  // so the workflow's notify step never claims work that did not happen.
  assert.equal(plan.cancel.length, 1);
  assert.match(formatSummary(plan, { dryRun: true }), /would cancel/);
  assert.equal(existsSync(discordFilePath), false);
  assert.equal(readFileSync(outputPath, 'utf8'), 'notify=false\n');
});

void test('only holding runs cost a jobs lookup', async () => {
  const lookedUp = [];

  await runCli({
    github: {
      listRuns: () => ({
        runs: [
          run({ id: 1, status: 'completed', conclusion: 'success' }),
          run({ id: 2, status: 'pending' }),
          run({ id: 3, status: 'waiting' }),
        ],
        recentPageOk: true,
      }),
      listJobs: (runId) => {
        lookedUp.push(runId);
        return [{ name: 'check-rollback', status: 'waiting' }];
      },
      cancelRun: () => {},
      dispatchRun: () => {},
    },
    headSha: HEAD_SHA,
    nowMs: NOW,
    now: () => NOW,
    runUrlBase: '',
    discordFilePath: '',
    outputPath: '',
    dryRun: true,
  });

  assert.deepEqual(lookedUp, [3]);
});

function fakeClock() {
  let currentMs = NOW;
  return {
    now: () => currentMs,
    sleep: async (milliseconds) => {
      currentMs += milliseconds;
    },
  };
}

function cancellationScenario({
  currentRun = run(),
  currentJobs = [{ name: 'sync-static-assets', status: 'queued' }],
} = {}) {
  const clock = fakeClock();
  const calls = [];
  let observedRun = currentRun;
  let observedJobs = currentJobs;
  const github = {
    getRun: () => observedRun,
    listJobs: () => observedJobs,
    cancelRun: () => calls.push('cancel'),
    forceCancelRun: () => {
      calls.push('force');
      observedRun = { ...observedRun, status: 'completed', conclusion: 'cancelled' };
    },
  };
  return {
    clock,
    calls,
    github,
    setRun: (nextRun) => {
      observedRun = nextRun;
    },
    setJobs: (nextJobs) => {
      observedJobs = nextJobs;
    },
    options: { github, ...clock, runId: currentRun.id, deadlineMs: NOW + 8 * 60_000 },
  };
}

void test('idle cancellation starts at 45 minutes without job activity', () => {
  for (const [idle, expected] of [
    [44.999, 'none'],
    [45, 'cancel'],
    [45.001, 'cancel'],
  ]) {
    const verdict = classifyRun({
      run: run(),
      jobs: [
        { name: 'build', status: 'completed', started_at: minutesAgo(60), completed_at: minutesAgo(idle) },
        { name: 'sync-static-assets', status: 'queued' },
      ],
      nowMs: NOW,
    });
    assert.equal(verdict.action, expected, `idle=${idle}`);
  }
});

void test('cancellation metadata does not reset the idle timer', () => {
  const verdict = classifyRun({
    run: run({ updated_at: minutesAgo(1) }),
    jobs: [
      { name: 'build', status: 'completed', started_at: minutesAgo(80), completed_at: minutesAgo(60) },
      { name: 'sync-static-assets', status: 'queued' },
    ],
    nowMs: NOW,
  });
  assert.equal(verdict.action, 'cancel');
});

void test('active migration has a six-hour cancellation ceiling', () => {
  for (const [age, expected] of [
    [DEFAULT_MAX_RUN_MINUTES - 0.001, 'alert'],
    [DEFAULT_MAX_RUN_MINUTES, 'cancel'],
    [DEFAULT_MAX_RUN_MINUTES + 0.001, 'cancel'],
  ]) {
    assert.equal(
      classifyRun({
        run: run({ status: 'in_progress', run_started_at: minutesAgo(age) }),
        jobs: [{ name: 'migrate', status: 'in_progress', started_at: minutesAgo(1) }],
        nowMs: NOW,
      }).action,
      expected,
      `age=${age}`,
    );
  }
});

void test('accepted cancellation stuck queued is force-cancelled after five minutes', async () => {
  const scenario = cancellationScenario();
  assert.equal(await cancelAndConfirm(scenario.options), 'stopped');
  assert.deepEqual(scenario.calls, ['cancel', 'force']);
  assert.equal(scenario.clock.now() - NOW, CANCEL_GRACE_MS);
});

void test('normal cancellation confirms completion without force cancellation', async () => {
  const scenario = cancellationScenario();
  scenario.github.cancelRun = () => {
    scenario.calls.push('cancel');
    scenario.setRun(run({ status: 'completed', conclusion: 'cancelled' }));
  };
  assert.equal(await cancelAndConfirm(scenario.options), 'stopped');
  assert.deepEqual(scenario.calls, ['cancel']);
  assert.ok(scenario.clock.now() - NOW < CANCEL_GRACE_MS);
});

void test('completion before requesting cancellation makes no mutation', async () => {
  const scenario = cancellationScenario({ currentRun: run({ status: 'completed', conclusion: 'success' }) });
  assert.equal(await cancelAndConfirm(scenario.options), 'stopped');
  assert.deepEqual(scenario.calls, []);
});

void test('resumed work before the cancellation request is preserved', async () => {
  const scenario = cancellationScenario({
    currentRun: run({ status: 'in_progress' }),
    currentJobs: [{ name: 'build', status: 'in_progress', started_at: minutesAgo(1) }],
  });
  assert.equal(await cancelAndConfirm(scenario.options), 'resumed');
  assert.deepEqual(scenario.calls, []);
});

void test('job activity resuming during cancellation prevents force cancellation', async () => {
  const scenario = cancellationScenario();
  scenario.github.cancelRun = () => {
    scenario.calls.push('cancel');
    scenario.setRun(run({ status: 'in_progress' }));
    scenario.setJobs([{ name: 'build', status: 'in_progress', started_at: new Date(NOW).toISOString() }]);
  };
  assert.equal(await cancelAndConfirm(scenario.options), 'resumed');
  assert.deepEqual(scenario.calls, ['cancel']);
});

void test('recent completed job activity prevents force cancellation too', async () => {
  const scenario = cancellationScenario();
  scenario.github.cancelRun = () => {
    scenario.calls.push('cancel');
    scenario.setJobs([
      { name: 'build', status: 'completed', completed_at: new Date(NOW).toISOString() },
      { name: 'sync-static-assets', status: 'queued' },
    ]);
  };
  assert.equal(await cancelAndConfirm(scenario.options), 'resumed');
  assert.deepEqual(scenario.calls, ['cancel']);
});

void test('six-hour ceiling still forces cancellation of an active migration', async () => {
  const scenario = cancellationScenario({
    currentRun: run({ status: 'in_progress', run_started_at: minutesAgo(DEFAULT_MAX_RUN_MINUTES + 1) }),
    currentJobs: [{ name: 'migrate', status: 'in_progress', started_at: minutesAgo(1) }],
  });
  assert.equal(await cancelAndConfirm(scenario.options), 'stopped');
  assert.deepEqual(scenario.calls, ['cancel', 'force']);
});

void test('409 cancellation race is successful only when run completion is confirmed', async () => {
  const scenario = cancellationScenario();
  scenario.github.cancelRun = () => {
    scenario.setRun(run({ status: 'completed', conclusion: 'success' }));
    throw new Error('HTTP 409: cannot cancel a completed run');
  };
  assert.equal(await cancelAndConfirm(scenario.options), 'stopped');
  assert.deepEqual(scenario.calls, []);
});

void test('rejected cancellation of a live run reports failure', async () => {
  const scenario = cancellationScenario();
  scenario.github.cancelRun = () => {
    throw new Error('HTTP 403: cancellation denied');
  };
  await assert.rejects(cancelAndConfirm(scenario.options), /403/);
  assert.deepEqual(scenario.calls, []);
});

void test('unconfirmed force cancellation fails within the confirmation window', async () => {
  const scenario = cancellationScenario();
  scenario.github.forceCancelRun = () => scenario.calls.push('force');
  await assert.rejects(cancelAndConfirm(scenario.options), /confirm|stopp|complet/i);
  assert.deepEqual(scenario.calls, ['cancel', 'force']);
  assert.equal(scenario.clock.now() - NOW, CANCEL_GRACE_MS + FORCE_CONFIRM_MS);
});

void test('the global deadline bounds a cancellation pass', async () => {
  const scenario = cancellationScenario();
  scenario.options.deadlineMs = NOW + 30_000;
  scenario.github.forceCancelRun = () => scenario.calls.push('force');
  await assert.rejects(cancelAndConfirm(scenario.options), /deadline|time|budget/i);
  assert.ok(scenario.clock.now() - NOW <= 30_000);
});

void test('cancelled jobs do not count as resumed deployment activity', async () => {
  const scenario = cancellationScenario();
  scenario.github.cancelRun = () => {
    scenario.calls.push('cancel');
    scenario.setJobs([
      { name: 'build', status: 'completed', conclusion: 'cancelled', completed_at: new Date(NOW).toISOString() },
      { name: 'sync-static-assets', status: 'queued' },
    ]);
  };
  assert.equal(await cancelAndConfirm(scenario.options), 'stopped');
  assert.deepEqual(scenario.calls, ['cancel', 'force']);
});

void test('an incomplete job list cannot justify idle cancellation', () => {
  assert.equal(classifyRun({ run: run(), jobs: null, nowMs: NOW }).action, 'none');
});

void test('a truncated job list is rejected rather than appearing idle', () => {
  const github = createCliGitHub({
    repository: 'example/repository',
    workflowFile: 'production-deploy.yml',
    api: () => JSON.stringify({ total_count: 501, jobs: Array.from({ length: 100 }, () => ({ status: 'queued' })) }),
  });
  assert.equal(github.listJobs(1), null);
});

void test('an empty page before total_count is exhausted is rejected', () => {
  let requests = 0;
  const github = createCliGitHub({
    repository: 'example/repository',
    workflowFile: 'production-deploy.yml',
    api: () => {
      requests += 1;
      return JSON.stringify({ total_count: 2, jobs: requests === 1 ? [{ status: 'queued' }] : [] });
    },
  });
  assert.equal(github.listJobs(1), null);
});

void test('an incomplete job list during confirmation prevents force cancellation', async () => {
  const scenario = cancellationScenario();
  scenario.github.cancelRun = () => {
    scenario.calls.push('cancel');
    scenario.github.listJobs = () => null;
  };
  await assert.rejects(cancelAndConfirm(scenario.options), /job|confirm|eligib|unread/i);
  assert.deepEqual(scenario.calls, ['cancel']);
});

void test('refreshing deployment history preserves a successor that appeared during cancellation', async () => {
  const cancelled = [];
  const dispatched = [];
  const stalled = run({ id: 7, status: 'waiting', head_sha: HEAD_SHA });
  const successor = run({ id: 8, status: 'pending', head_sha: HEAD_SHA });
  const plan = await runCli({
    github: {
      listRuns: () => ({
        runs: cancelled.length ? [{ ...stalled, status: 'completed', conclusion: 'cancelled' }, successor] : [stalled],
        recentPageOk: true,
      }),
      getRun: () => (cancelled.length ? { ...stalled, status: 'completed' } : stalled),
      listJobs: () => [{ name: 'sync-static-assets', status: 'queued' }],
      cancelRun: (runId) => cancelled.push(runId),
      dispatchRun: (ref) => dispatched.push(ref),
    },
    headSha: HEAD_SHA,
    nowMs: NOW,
    now: () => NOW,
    runUrlBase: '',
    discordFilePath: '',
    outputPath: '',
    dryRun: false,
  });
  assert.deepEqual(cancelled, [7]);
  assert.deepEqual(dispatched, []);
  assert.equal(plan.followUp, 'queued-run-takes-over');
});

void test('failed status queries mark run history incomplete for redispatch', () => {
  const github = createCliGitHub({
    repository: 'example/repository',
    workflowFile: 'production-deploy.yml',
    api: (argumentsList) => {
      const endpoint = argumentsList.find((argument) => argument.startsWith('repos/'));
      if (endpoint.includes('status=pending')) throw new Error('HTTP 503');
      return JSON.stringify({ workflow_runs: [] });
    },
  });
  const history = github.listRuns();
  assert.equal(history.recentPageOk, false);
});

void test('unconfirmed force cancellation blocks retry and emits a failure report', async () => {
  const scenario = cancellationScenario();
  scenario.github.forceCancelRun = () => scenario.calls.push('force');
  scenario.github.listRuns = () => ({ runs: [run({ head_sha: HEAD_SHA })], recentPageOk: true });
  scenario.github.dispatchRun = () => assert.fail('unconfirmed cancellation must not dispatch');
  const workDirectory = mkdtempSync(join(tmpdir(), 'boardsesh-watchdog-'));
  const discordFilePath = join(workDirectory, 'discord.txt');
  const outputPath = join(workDirectory, 'github-output.txt');
  const result = await runCli({
    github: scenario.github,
    headSha: HEAD_SHA,
    ...scenario.clock,
    runUrlBase: '',
    discordFilePath,
    outputPath,
    dryRun: false,
  });
  assert.equal(result.failed, true);
  assert.deepEqual(scenario.calls, ['cancel', 'force']);
  const report = readFileSync(discordFilePath, 'utf8');
  assert.match(report, /still wedged/);
  assert.doesNotMatch(report, /Stopped run|Dispatched a fresh deploy/);
  assert.equal(readFileSync(outputPath, 'utf8'), 'notify=true\n');
});

void test('a sole idle target resuming before cancellation does not spend a retry', async () => {
  const mutations = [];
  const plan = await runCli({
    github: {
      listRuns: () => ({ runs: [run({ head_sha: HEAD_SHA })], recentPageOk: true }),
      listJobs: () => [{ name: 'sync-static-assets', status: 'queued' }],
      getRun: () => run({ status: 'in_progress', run_started_at: minutesAgo(1), head_sha: HEAD_SHA }),
      cancelRun: () => mutations.push('cancel'),
      forceCancelRun: () => mutations.push('force'),
      dispatchRun: () => mutations.push('dispatch'),
    },
    headSha: HEAD_SHA,
    now: () => NOW,
    runUrlBase: '',
    discordFilePath: '',
    outputPath: '',
    dryRun: false,
  });
  assert.deepEqual(mutations, []);
  assert.equal(plan.redispatch, false);
});

void test('malformed run history withholds redispatch', () => {
  const github = createCliGitHub({
    repository: 'example/repository',
    workflowFile: 'production-deploy.yml',
    api: () => JSON.stringify({ message: 'unexpected response' }),
  });
  assert.equal(github.listRuns().recentPageOk, false);
});

void test('cancelling a queued job does not turn its recent start timestamp into progress', async () => {
  const recentTimestamp = new Date(NOW).toISOString();
  const scenario = cancellationScenario({
    currentJobs: [
      { name: 'build', status: 'queued', started_at: recentTimestamp },
      { name: 'sync-static-assets', status: 'queued' },
    ],
  });
  scenario.github.cancelRun = () => {
    scenario.calls.push('cancel');
    scenario.setJobs([
      {
        name: 'build',
        status: 'completed',
        conclusion: 'cancelled',
        started_at: recentTimestamp,
        completed_at: recentTimestamp,
      },
      { name: 'sync-static-assets', status: 'queued' },
    ]);
  };
  assert.equal(await cancelAndConfirm(scenario.options), 'stopped');
  assert.deepEqual(scenario.calls, ['cancel', 'force']);
  assert.equal(scenario.clock.now() - NOW, CANCEL_GRACE_MS);
});

void test('main advancing during cancellation uses the new heads retry history', async () => {
  const newerHeadSha = '3333333333333333333333333333333333333333';
  const stopped = [];
  const stalled = run({ head_sha: HEAD_SHA });
  const plan = await runCli({
    github: {
      listRuns: () => ({
        runs: stopped.length
          ? [
              { ...stalled, status: 'completed', conclusion: 'cancelled' },
              run({
                id: 2,
                head_sha: newerHeadSha,
                status: 'completed',
                conclusion: 'failure',
                event: 'workflow_dispatch',
              }),
            ]
          : [stalled],
        recentPageOk: true,
      }),
      getHeadSha: () => newerHeadSha,
      getRun: () => (stopped.length ? { ...stalled, status: 'completed' } : stalled),
      listJobs: () => [{ name: 'sync-static-assets', status: 'queued' }],
      cancelRun: (runId) => stopped.push(runId),
      dispatchRun: () => assert.fail('the newer commit has already spent its retry'),
    },
    headSha: HEAD_SHA,
    now: () => NOW,
    runUrlBase: '',
    discordFilePath: '',
    outputPath: '',
    dryRun: false,
  });
  assert.deepEqual(stopped, [1]);
  assert.equal(plan.redispatch, false);
  assert.equal(plan.followUp, 'needs-intervention');
});

void test('GitHub adapter reads runs and calls distinct normal and force cancellation endpoints', () => {
  const requests = [];
  const github = createCliGitHub({
    repository: 'example/repository',
    workflowFile: 'production-deploy.yml',
    api: (argumentsList) => {
      requests.push(argumentsList);
      return JSON.stringify(run({ id: 42 }));
    },
  });
  assert.equal(github.getRun(42).id, 42);
  github.cancelRun(42);
  github.forceCancelRun(42);
  assert.deepEqual(requests, [
    ['--method', 'GET', 'repos/example/repository/actions/runs/42'],
    ['--method', 'POST', 'repos/example/repository/actions/runs/42/cancel'],
    ['--method', 'POST', 'repos/example/repository/actions/runs/42/force-cancel'],
  ]);
});

void test('the workflow bounds watchdog runtime and sends failure notifications', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/production-deploy-watchdog.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /^    timeout-minutes: 10$/m);
  assert.match(workflow, /^        if: always\(\) && steps\.watchdog\.outputs\.notify == 'true'$/m);
  assert.match(workflow, /exit "\$watchdog_status"/);
});

void test('normal cancellation 409 for a live queued run still escalates to force cancellation', async () => {
  const scenario = cancellationScenario();
  scenario.github.cancelRun = () => {
    scenario.calls.push('cancel');
    throw new Error('HTTP 409: workflow run cannot be cancelled');
  };
  assert.equal(await cancelAndConfirm(scenario.options), 'stopped');
  assert.deepEqual(scenario.calls, ['cancel', 'force']);
  assert.equal(scenario.clock.now() - NOW, CANCEL_GRACE_MS);
});

void test('dry run refreshes an advancing main and preserves its spent manual retry', async () => {
  const newerHeadSha = '3333333333333333333333333333333333333333';
  const stalled = run({ head_sha: HEAD_SHA });
  let historyReads = 0;
  const plan = await runCli({
    github: {
      listRuns: () => {
        historyReads += 1;
        return {
          runs:
            historyReads > 1
              ? [
                  stalled,
                  run({
                    id: 2,
                    head_sha: newerHeadSha,
                    status: 'completed',
                    conclusion: 'failure',
                    event: 'workflow_dispatch',
                  }),
                ]
              : [stalled],
          recentPageOk: true,
        };
      },
      getHeadSha: () => newerHeadSha,
      listJobs: () => [{ name: 'sync-static-assets', status: 'queued' }],
      getRun: () => assert.fail('dry run must not initiate cancellation confirmation'),
      cancelRun: () => assert.fail('dry run must not cancel'),
      forceCancelRun: () => assert.fail('dry run must not force-cancel'),
      dispatchRun: () => assert.fail('dry run must not dispatch'),
    },
    headSha: HEAD_SHA,
    now: () => NOW,
    runUrlBase: '',
    discordFilePath: '',
    outputPath: '',
    dryRun: true,
  });
  assert.equal(historyReads, 2);
  assert.equal(plan.cancel.length, 1);
  assert.equal(plan.redispatch, false);
  assert.equal(plan.followUp, 'needs-intervention');
  assert.doesNotMatch(formatSummary(plan, { dryRun: true }), /would dispatch/);
});

void test('multiple cancellation targets share the eight-minute watchdog deadline', async () => {
  const clock = fakeClock();
  const mutations = [];
  const stoppedRunIds = new Set();
  const stalledRuns = [
    run({ id: 1, run_number: 101, head_sha: HEAD_SHA }),
    run({ id: 2, run_number: 102, head_sha: HEAD_SHA }),
  ];
  const workDirectory = mkdtempSync(join(tmpdir(), 'boardsesh-watchdog-'));
  const discordFilePath = join(workDirectory, 'discord.txt');
  const outputPath = join(workDirectory, 'github-output.txt');
  const result = await runCli({
    github: {
      listRuns: () => ({
        runs: stalledRuns.map((stalledRun) =>
          stoppedRunIds.has(stalledRun.id)
            ? { ...stalledRun, status: 'completed', conclusion: 'cancelled' }
            : stalledRun,
        ),
        recentPageOk: true,
      }),
      getRun: (runId) =>
        stoppedRunIds.has(runId)
          ? run({ id: runId, status: 'completed', conclusion: 'cancelled' })
          : run({ id: runId }),
      listJobs: () => [{ name: 'sync-static-assets', status: 'queued' }],
      cancelRun: (runId) => mutations.push(`cancel-${runId}`),
      forceCancelRun: (runId) => {
        mutations.push(`force-${runId}`);
        stoppedRunIds.add(runId);
      },
      dispatchRun: () => assert.fail('an unfinished cancellation must not spend a retry'),
    },
    headSha: HEAD_SHA,
    ...clock,
    runUrlBase: '',
    discordFilePath,
    outputPath,
    dryRun: false,
  });
  assert.equal(clock.now() - NOW, 8 * 60_000);
  assert.deepEqual(mutations, ['cancel-1', 'force-1', 'cancel-2']);
  assert.deepEqual([...stoppedRunIds], [1]);
  assert.equal(result.failed, true);
  assert.equal(result.followUp, 'cancel-failed');
  const report = readFileSync(discordFilePath, 'utf8');
  assert.match(report, /Stopped run #101/);
  assert.match(report, /Could NOT cancel run #102/);
  assert.match(report, /still wedged/);
  assert.doesNotMatch(report, /Stopped run #102|Dispatched a fresh deploy/);
  assert.equal(readFileSync(outputPath, 'utf8'), 'notify=true\n');
});

void test('a later tick recovers a confirmed cancellation after transient history failure', async () => {
  const stalled = run({ id: 10, head_sha: HEAD_SHA });
  let cancelled = false;
  let tick = 1;
  const dispatched = [];
  let historyReads = 0;
  const github = {
    listRuns: () => {
      historyReads += 1;
      if (tick === 1 && cancelled) throw new Error('HTTP 503: temporary history failure');
      const runs = [cancelled ? { ...stalled, status: 'completed', conclusion: 'cancelled' } : stalled];
      if (dispatched.length > 0) {
        runs.push(
          run({ id: 11, head_sha: HEAD_SHA, event: 'workflow_dispatch', status: 'completed', conclusion: 'cancelled' }),
        );
      }
      return { runs, recentPageOk: true };
    },
    getHeadSha: () => HEAD_SHA,
    getRun: () => (cancelled ? { ...stalled, status: 'completed', conclusion: 'cancelled' } : stalled),
    listJobs: () => [{ name: 'sync-static-assets', status: 'queued' }],
    cancelRun: () => {
      cancelled = true;
    },
    forceCancelRun: () => assert.fail('ordinary cancellation completed'),
    dispatchRun: (ref) => dispatched.push(ref),
  };
  const discordFilePath = join(mkdtempSync(join(tmpdir(), 'boardsesh-watchdog-')), 'discord.txt');
  const options = {
    github,
    headSha: HEAD_SHA,
    now: () => NOW,
    runUrlBase: '',
    discordFilePath,
    outputPath: '',
    dryRun: false,
  };
  const first = await runCli(options);
  assert.equal(first.failed, true);
  assert.deepEqual(dispatched, []);
  tick = 2;
  historyReads = 0;
  const second = await runCli(options);
  assert.equal(second.failed, false);
  assert.equal(second.cancel.length, 0);
  assert.equal(historyReads, 2);
  assert.deepEqual(dispatched, ['main']);
  const recoveredReport = readFileSync(discordFilePath, 'utf8');
  assert.match(recoveredReport, /Dispatched a fresh deploy/);
  assert.doesNotMatch(recoveredReport, /Stopped run|Could NOT cancel run/);
  tick = 3;
  const third = await runCli(options);
  assert.equal(third.redispatch, false);
  assert.deepEqual(dispatched, ['main']);
});

void test('only the latest numeric run ID can trigger deferred cancellation recovery', () => {
  const cancelled = run({ id: 9, status: 'completed', conclusion: 'cancelled', head_sha: HEAD_SHA });
  const failed = run({ id: 10, status: 'completed', conclusion: 'failure', head_sha: HEAD_SHA });
  assert.equal(planWatchdogActions({ runs: [failed, cancelled], headSha: HEAD_SHA, nowMs: NOW }).redispatch, false);
  assert.equal(planWatchdogActions({ runs: [cancelled, failed], headSha: HEAD_SHA, nowMs: NOW }).redispatch, false);
  assert.equal(planWatchdogActions({ runs: [cancelled], headSha: HEAD_SHA, nowMs: NOW }).redispatch, true);
});

void test('deferred cancellation recovery preserves pending successors and deployed heads', () => {
  const cancelled = run({ id: 10, status: 'completed', conclusion: 'cancelled', head_sha: HEAD_SHA });
  const pending = run({ id: 11, status: 'pending', head_sha: HEAD_SHA });
  const deployed = run({ id: 9, status: 'completed', conclusion: 'success', head_sha: HEAD_SHA });
  assert.equal(planWatchdogActions({ runs: [cancelled, pending], headSha: HEAD_SHA, nowMs: NOW }).redispatch, false);
  assert.equal(planWatchdogActions({ runs: [cancelled, deployed], headSha: HEAD_SHA, nowMs: NOW }).redispatch, false);
});

void test('deferred recovery refreshes an advancing main before spending its retry', async () => {
  const newerHeadSha = '3333333333333333333333333333333333333333';
  const cancelled = run({ id: 10, head_sha: HEAD_SHA, status: 'completed', conclusion: 'cancelled' });
  let historyReads = 0;
  const result = await runCli({
    github: {
      listRuns: () => {
        historyReads += 1;
        return {
          runs:
            historyReads > 1
              ? [
                  cancelled,
                  run({
                    id: 11,
                    head_sha: newerHeadSha,
                    event: 'workflow_dispatch',
                    status: 'completed',
                    conclusion: 'failure',
                  }),
                ]
              : [cancelled],
          recentPageOk: true,
        };
      },
      getHeadSha: () => newerHeadSha,
      listJobs: () => assert.fail('no live run needs jobs'),
      cancelRun: () => assert.fail('no live run needs cancellation'),
      dispatchRun: () => assert.fail('new head has spent its retry'),
    },
    headSha: HEAD_SHA,
    now: () => NOW,
    runUrlBase: '',
    discordFilePath: '',
    outputPath: '',
    dryRun: false,
  });
  assert.equal(historyReads, 2);
  assert.equal(result.redispatch, false);
});

void test('deferred recovery stops if refreshed history shows a later failed deploy', async () => {
  const cancelled = run({ id: 10, head_sha: HEAD_SHA, status: 'completed', conclusion: 'cancelled' });
  let historyReads = 0;
  const result = await runCli({
    github: {
      listRuns: () => {
        historyReads += 1;
        return {
          runs:
            historyReads > 1
              ? [cancelled, run({ id: 11, head_sha: HEAD_SHA, status: 'completed', conclusion: 'failure' })]
              : [cancelled],
          recentPageOk: true,
        };
      },
      getHeadSha: () => HEAD_SHA,
      listJobs: () => assert.fail('no live run needs jobs'),
      dispatchRun: () => assert.fail('a later failed deploy must not inherit cancellation recovery'),
    },
    headSha: HEAD_SHA,
    now: () => NOW,
    runUrlBase: '',
    discordFilePath: '',
    outputPath: '',
    dryRun: false,
  });
  assert.equal(historyReads, 2);
  assert.equal(result.redispatch, false);
});

void test('a recovery-only history failure reports deferred recovery without claiming cancellation', async () => {
  const cancelled = run({ id: 10, head_sha: HEAD_SHA, status: 'completed', conclusion: 'cancelled' });
  const workDirectory = mkdtempSync(join(tmpdir(), 'boardsesh-watchdog-'));
  const discordFilePath = join(workDirectory, 'discord.txt');
  const outputPath = join(workDirectory, 'github-output.txt');
  const result = await runCli({
    github: {
      listRuns: () => ({ runs: [cancelled], recentPageOk: true }),
      getHeadSha: () => {
        throw new Error('HTTP 503: main lookup failed');
      },
      dispatchRun: () => assert.fail('unreadable head must not dispatch'),
    },
    headSha: HEAD_SHA,
    now: () => NOW,
    runUrlBase: '',
    discordFilePath,
    outputPath,
    dryRun: false,
  });
  assert.equal(result.failed, true);
  assert.equal(result.followUp, 'dispatch-deferred');
  const report = readFileSync(discordFilePath, 'utf8');
  assert.match(report, /recovery|No deploy was started/);
  assert.doesNotMatch(report, /Stopped run|Could NOT cancel run|Dispatched a fresh deploy/);
  assert.equal(readFileSync(outputPath, 'utf8'), 'notify=true\n');
});

void test('a recovery-only dispatch failure reports deferred recovery', async () => {
  const cancelled = run({ id: 10, head_sha: HEAD_SHA, status: 'completed', conclusion: 'cancelled' });
  const discordFilePath = join(mkdtempSync(join(tmpdir(), 'boardsesh-watchdog-')), 'discord.txt');
  const result = await runCli({
    github: {
      listRuns: () => ({ runs: [cancelled], recentPageOk: true }),
      getHeadSha: () => HEAD_SHA,
      dispatchRun: () => {
        throw new Error('HTTP 503: dispatch failed');
      },
    },
    headSha: HEAD_SHA,
    now: () => NOW,
    runUrlBase: '',
    discordFilePath,
    outputPath: '',
    dryRun: false,
  });
  assert.equal(result.failed, true);
  assert.equal(result.followUp, 'dispatch-deferred');
  const report = readFileSync(discordFilePath, 'utf8');
  assert.match(report, /No (?:replacement )?deploy was started/);
  assert.doesNotMatch(report, /Stopped run|Could NOT cancel run|Dispatched a fresh deploy/);
});

void test('a recovery-only spent retry does not repeat intervention notifications', async () => {
  const manualCancelled = run({
    id: 10,
    head_sha: HEAD_SHA,
    status: 'completed',
    conclusion: 'cancelled',
    event: 'workflow_dispatch',
  });
  const workDirectory = mkdtempSync(join(tmpdir(), 'boardsesh-watchdog-'));
  const discordFilePath = join(workDirectory, 'discord.txt');
  const outputPath = join(workDirectory, 'github-output.txt');
  for (let tick = 0; tick < 2; tick += 1) {
    const result = await runCli({
      github: {
        listRuns: () => ({ runs: [manualCancelled], recentPageOk: true }),
        getHeadSha: () => HEAD_SHA,
        dispatchRun: () => assert.fail('retry already spent'),
      },
      headSha: HEAD_SHA,
      now: () => NOW,
      runUrlBase: '',
      discordFilePath,
      outputPath,
      dryRun: false,
    });
    assert.equal(result.failed, false);
    assert.equal(result.redispatch, false);
    assert.equal(result.followUp, 'needs-intervention');
  }
  assert.equal(existsSync(discordFilePath), false);
  assert.equal(readFileSync(outputPath, 'utf8'), 'notify=false\nnotify=false\n');
});

void test('an empty incomplete refreshed history retains the deferred recovery notification', async () => {
  const cancelled = run({ id: 10, head_sha: HEAD_SHA, status: 'completed', conclusion: 'cancelled' });
  let historyReads = 0;
  const workDirectory = mkdtempSync(join(tmpdir(), 'boardsesh-watchdog-'));
  const discordFilePath = join(workDirectory, 'discord.txt');
  const outputPath = join(workDirectory, 'github-output.txt');
  const result = await runCli({
    github: {
      listRuns: () => {
        historyReads += 1;
        return historyReads === 1 ? { runs: [cancelled], recentPageOk: true } : { runs: [], recentPageOk: false };
      },
      getHeadSha: () => HEAD_SHA,
      dispatchRun: () => assert.fail('incomplete history must not dispatch'),
    },
    headSha: HEAD_SHA,
    now: () => NOW,
    runUrlBase: '',
    discordFilePath,
    outputPath,
    dryRun: false,
  });
  assert.equal(result.failed, true);
  assert.equal(readFileSync(outputPath, 'utf8'), 'notify=true\n');
  assert.equal(result.followUp, 'dispatch-deferred');
  const report = readFileSync(discordFilePath, 'utf8');
  assert.match(report, /No (?:replacement )?deploy was started/);
  assert.doesNotMatch(report, /Stopped run|Could NOT cancel run|Dispatched a fresh deploy/);
});

void test('six-hour cancellation still escalates when job history is unreadable', async () => {
  const scenario = cancellationScenario({
    currentRun: run({ status: 'in_progress', run_started_at: minutesAgo(DEFAULT_MAX_RUN_MINUTES + 1) }),
    currentJobs: null,
  });
  assert.equal(await cancelAndConfirm(scenario.options), 'stopped');
  assert.deepEqual(scenario.calls, ['cancel', 'force']);
  assert.equal(scenario.clock.now() - NOW, CANCEL_GRACE_MS);
});

// ─── mobile-ota-production lane ──────────────────────────────────────────────

const OTA_RULES = laneRules(MOBILE_OTA_LANE);
const PRODUCTION_RULES = laneRules(PRODUCTION_DEPLOY_LANE);

function otaRun(overrides = {}) {
  return run({
    id: 40105607795,
    run_number: 1101,
    status: 'waiting',
    event: 'push',
    head_branch: 'release/next',
    display_title: 'Production OTA',
    ...overrides,
  });
}

// Run 40105607795's job list as GitHub reported it, shifted so the parked job
// has waited `parkedMinutes`: publish succeeded, then notify-train-deployment
// sat at the Production gate.
function octoberWedgeJobs(parkedMinutes) {
  const publishDone = parkedMinutes;
  return [
    {
      name: 'live-store-runtimes / resolve',
      status: 'completed',
      conclusion: 'success',
      created_at: minutesAgo(publishDone + 11),
      started_at: minutesAgo(publishDone + 10.9),
      completed_at: minutesAgo(publishDone + 10.4),
    },
    {
      name: 'resolve-staging-runtimes',
      status: 'completed',
      conclusion: 'skipped',
      created_at: minutesAgo(publishDone + 11),
      started_at: minutesAgo(publishDone + 11),
      completed_at: minutesAgo(publishDone + 11),
    },
    {
      name: 'publish',
      status: 'completed',
      conclusion: 'success',
      created_at: minutesAgo(publishDone + 10.4),
      started_at: minutesAgo(publishDone + 10.3),
      completed_at: minutesAgo(publishDone),
    },
    {
      name: 'notify-train-deployment',
      status: 'waiting',
      conclusion: null,
      created_at: minutesAgo(publishDone),
      started_at: minutesAgo(publishDone),
      completed_at: null,
    },
  ];
}

void test('OTA lane: the October 2026 wedge — notify parked 27 h after publish — is cancelled', () => {
  const verdict = classifyRun({
    run: otaRun({ run_started_at: minutesAgo(27 * 60 + 11), created_at: minutesAgo(27 * 60 + 11) }),
    jobs: octoberWedgeJobs(27 * 60),
    nowMs: NOW,
    ...OTA_RULES,
  });

  assert.equal(verdict.action, 'cancel');
  assert.match(verdict.reason, /parked for 1d 3h with no job executing/);
  assert.match(verdict.reason, /parked: notify-train-deployment \(waiting\)/);
});

void test('OTA lane: a waiting job is left alone until 45 minutes without job progress', () => {
  for (const [parked, expected] of [
    [DEFAULT_STALL_MINUTES - 0.001, 'none'],
    [DEFAULT_STALL_MINUTES, 'cancel'],
  ]) {
    const verdict = classifyRun({ run: otaRun(), jobs: octoberWedgeJobs(parked), nowMs: NOW, ...OTA_RULES });
    assert.equal(verdict.action, expected, `parked=${parked}`);
  }
});

void test('OTA lane: an executing publish is never cancelled or alerted on, however old the run', () => {
  // No created_at on the jobs, so the run's own start is the only age signal —
  // a day old. production-deploy's ceiling would cancel this; the OTA lane has
  // none, because killing a publish part-way can leave one platform published.
  const oldRun = otaRun({
    status: 'in_progress',
    run_started_at: minutesAgo(24 * 60),
    created_at: minutesAgo(24 * 60),
  });
  const jobs = [
    {
      name: 'live-store-runtimes / resolve',
      status: 'completed',
      conclusion: 'success',
      completed_at: minutesAgo(301),
    },
    { name: 'publish', status: 'in_progress', started_at: minutesAgo(300) },
    { name: 'notify-train-deployment', status: 'waiting' },
  ];

  assert.equal(classifyRun({ run: oldRun, jobs, nowMs: NOW, ...OTA_RULES }).action, 'none');
  assert.equal(classifyRun({ run: oldRun, jobs, nowMs: NOW, ...PRODUCTION_RULES }).action, 'cancel');
});

void test('OTA lane: a job queued for a runner is not parked', () => {
  // Only the environment gate counts. A runner queue clears on its own, and
  // cancelling it would throw away a republish nothing re-sends.
  const jobs = [
    {
      name: 'live-store-runtimes / resolve',
      status: 'completed',
      conclusion: 'success',
      completed_at: minutesAgo(120),
    },
    { name: 'publish', status: 'queued', created_at: minutesAgo(120) },
  ];

  assert.equal(isParked(otaRun({ status: 'queued' }), jobs, MOBILE_OTA_LANE.parkedJobStatuses), false);
  assert.equal(classifyRun({ run: otaRun({ status: 'queued' }), jobs, nowMs: NOW, ...OTA_RULES }).action, 'none');
  assert.equal(
    classifyRun({ run: otaRun({ status: 'queued' }), jobs, nowMs: NOW, ...PRODUCTION_RULES }).action,
    'cancel',
  );
});

void test('a run released from the queue is timed from its first job, not its trigger time', () => {
  // The 2026-10-25 dispatch: created 05:25, released 18:31, run_started_at
  // still 05:25. A minute after release its publish reaches the gate.
  const released = otaRun({
    id: 40165505768,
    event: 'workflow_dispatch',
    created_at: minutesAgo(13 * 60 + 6),
    run_started_at: minutesAgo(13 * 60 + 6),
  });
  const justReachedGate = [
    { name: 'resolve-staging-runtimes', status: 'completed', conclusion: 'skipped', created_at: minutesAgo(1) },
    { name: 'publish', status: 'waiting', created_at: minutesAgo(0.5), started_at: minutesAgo(0.5) },
  ];
  for (const rules of [OTA_RULES, PRODUCTION_RULES]) {
    assert.equal(classifyRun({ run: released, jobs: justReachedGate, nowMs: NOW, ...rules }).action, 'none');
  }

  // Same for production-deploy's six-hour ceiling: a deploy queued 7 h ago that
  // started migrating an hour ago has held the group for one hour, not seven.
  const queuedDeploy = run({
    status: 'in_progress',
    created_at: minutesAgo(7 * 60),
    run_started_at: minutesAgo(7 * 60),
  });
  const migrating = [
    {
      name: 'detect-changes',
      status: 'completed',
      conclusion: 'success',
      created_at: minutesAgo(60),
      completed_at: minutesAgo(58),
    },
    { name: 'migrate', status: 'in_progress', created_at: minutesAgo(58), started_at: minutesAgo(57) },
  ];
  assert.equal(classifyRun({ run: queuedDeploy, jobs: migrating, nowMs: NOW, ...PRODUCTION_RULES }).action, 'none');
});

void test('jobs created by a cancellation do not move the hold start forward', () => {
  // Cancelling can materialise downstream jobs with a fresh created_at. The
  // earliest job still dates the hold, so the idle timer is not reset.
  const jobs = [
    ...octoberWedgeJobs(90),
    {
      name: 'later-job',
      status: 'completed',
      conclusion: 'cancelled',
      created_at: minutesAgo(0),
      completed_at: minutesAgo(0),
    },
  ];
  assert.equal(classifyRun({ run: otaRun(), jobs, nowMs: NOW, ...OTA_RULES }).action, 'cancel');
});

void test('OTA lane: only the holder is a target, and nothing is dispatched', () => {
  const holder = otaRun();
  const pendingRuns = [
    otaRun({ id: 40105700000, run_number: 1102, status: 'pending' }),
    otaRun({ id: 40105800000, run_number: 1103, status: 'pending', event: 'workflow_dispatch' }),
  ];
  const plan = planWatchdogActions({
    runs: [...pendingRuns, holder],
    jobsByRunId: { [holder.id]: octoberWedgeJobs(27 * 60) },
    headSha: HEAD_SHA,
    nowMs: NOW,
    lane: MOBILE_OTA_LANE,
  });

  assert.deepEqual(
    plan.cancel.map((entry) => entry.run.id),
    [holder.id],
  );
  assert.equal(plan.redispatch, false);
  assert.equal(plan.followUp, 'queue-resumes');

  // production-deploy's deferred recovery reads "latest run cancelled" as a
  // reason to dispatch. The OTA lane has no such recovery.
  const afterManualCancel = planWatchdogActions({
    runs: [otaRun({ id: 2, status: 'completed', conclusion: 'cancelled', head_sha: HEAD_SHA })],
    headSha: HEAD_SHA,
    nowMs: NOW,
    lane: MOBILE_OTA_LANE,
  });
  assert.equal(afterManualCancel.recoveringCancelledRun, false);
  assert.equal(afterManualCancel.redispatch, false);
  assert.equal(formatDiscordContent(afterManualCancel, { lane: MOBILE_OTA_LANE }), '');
  assert.equal(formatSummary(afterManualCancel, { lane: MOBILE_OTA_LANE }), 'no stalled mobile OTA run found');
});

void test('OTA lane: the CLI cancels the holder, never dispatches, and reports the lane', async () => {
  const cancelled = [];
  let historyReads = 0;
  const holder = otaRun();
  const pending = otaRun({ id: 40106937794, run_number: 1102, status: 'pending' });
  const workDirectory = mkdtempSync(join(tmpdir(), 'boardsesh-watchdog-'));
  const discordFilePath = join(workDirectory, 'discord.txt');
  const outputPath = join(workDirectory, 'github-output.txt');

  const result = await runCli({
    github: {
      listRuns: () => {
        historyReads += 1;
        return { runs: [pending, holder], recentPageOk: true };
      },
      listJobs: () => octoberWedgeJobs(27 * 60),
      getRun: (runId) =>
        cancelled.includes(runId) ? { ...holder, status: 'completed', conclusion: 'cancelled' } : holder,
      cancelRun: (runId) => cancelled.push(runId),
      forceCancelRun: () => assert.fail('ordinary cancellation completed'),
      getHeadSha: () => assert.fail('the OTA lane has no head to redeploy'),
      dispatchRun: () => assert.fail('the OTA lane never dispatches'),
    },
    lane: MOBILE_OTA_LANE,
    headSha: HEAD_SHA,
    now: () => NOW,
    runUrlBase: 'https://example.test/actions/runs',
    discordFilePath,
    outputPath,
    dryRun: false,
  });

  assert.deepEqual(cancelled, [holder.id]);
  // No post-cancel history refresh: nothing the OTA lane decides depends on it.
  assert.equal(historyReads, 1);
  assert.equal(result.failed, false);
  assert.equal(result.followUp, 'queue-resumes');
  const report = readFileSync(discordFilePath, 'utf8');
  assert.match(report, /Mobile OTA lane unwedged/);
  assert.match(report, /Stopped run #1101 \(`1111111` on release\/next, "Production OTA"\)/);
  assert.match(report, /parked: notify-train-deployment \(waiting\)/);
  assert.match(report, /queue: max/);
  assert.match(report, /<https:\/\/example\.test\/actions\/runs\/40105607795>/);
  assert.doesNotMatch(report, /Production deploy|Dispatched a fresh deploy/);
  assert.equal(readFileSync(outputPath, 'utf8'), 'notify=true\n');
});

void test('OTA lane: a cancel that does not land reports the lane still wedged and fails', async () => {
  const discordFilePath = join(mkdtempSync(join(tmpdir(), 'boardsesh-watchdog-')), 'discord.txt');
  const result = await runCli({
    github: {
      listRuns: () => ({ runs: [otaRun()], recentPageOk: true }),
      listJobs: () => octoberWedgeJobs(27 * 60),
      getRun: () => otaRun(),
      cancelRun: () => {
        throw new Error('HTTP 403: cancellation denied');
      },
      dispatchRun: () => assert.fail('the OTA lane never dispatches'),
    },
    lane: MOBILE_OTA_LANE,
    headSha: HEAD_SHA,
    now: () => NOW,
    runUrlBase: '',
    discordFilePath,
    outputPath: '',
    dryRun: false,
  });

  assert.equal(result.failed, true);
  assert.equal(result.followUp, 'cancel-failed');
  const report = readFileSync(discordFilePath, 'utf8');
  assert.match(report, /Mobile OTA lane still wedged/);
  assert.match(report, /Could NOT cancel run #1101/);
  assert.match(report, /lane may still be held/);
  assert.doesNotMatch(report, /unwedged/);
});

void test('OTA lane: a dry run names the run and branch without touching anything', async () => {
  const workDirectory = mkdtempSync(join(tmpdir(), 'boardsesh-watchdog-'));
  const discordFilePath = join(workDirectory, 'discord.txt');
  const outputPath = join(workDirectory, 'github-output.txt');
  const plan = await runCli({
    github: {
      listRuns: () => ({ runs: [otaRun()], recentPageOk: true }),
      listJobs: () => octoberWedgeJobs(27 * 60),
      getRun: () => assert.fail('dry run must not initiate cancellation confirmation'),
      cancelRun: () => assert.fail('dry run must not cancel'),
      dispatchRun: () => assert.fail('dry run must not dispatch'),
    },
    lane: MOBILE_OTA_LANE,
    headSha: HEAD_SHA,
    now: () => NOW,
    runUrlBase: '',
    discordFilePath,
    outputPath,
    dryRun: true,
  });

  assert.equal(plan.cancel.length, 1);
  assert.match(
    formatSummary(plan, { dryRun: true, lane: MOBILE_OTA_LANE }),
    /^would cancel run #1101 \(1111111 on release\/next, "Production OTA", status=waiting\)/,
  );
  assert.equal(existsSync(discordFilePath), false);
  assert.equal(readFileSync(outputPath, 'utf8'), 'notify=false\n');
});

void test('OTA lane: a publish that resumes during cancellation is never force-cancelled, however old', async () => {
  // The re-check before force-cancel must use the OTA lane's rules. Under
  // production-deploy's six-hour ceiling this same run is force-cancelled
  // mid-publish — the second half shows the difference is the rules passed in.
  const scenarioFor = (rules) => {
    const scenario = cancellationScenario({
      currentRun: otaRun({ run_started_at: minutesAgo(DEFAULT_MAX_RUN_MINUTES + 60) }),
      currentJobs: [{ name: 'publish', status: 'waiting' }],
    });
    scenario.github.cancelRun = () => {
      scenario.calls.push('cancel');
      scenario.setRun(otaRun({ status: 'in_progress', run_started_at: minutesAgo(DEFAULT_MAX_RUN_MINUTES + 60) }));
      scenario.setJobs([{ name: 'publish', status: 'in_progress', started_at: new Date(NOW).toISOString() }]);
    };
    return { scenario, options: { ...scenario.options, rules } };
  };

  const ota = scenarioFor(OTA_RULES);
  assert.equal(await cancelAndConfirm(ota.options), 'resumed');
  assert.deepEqual(ota.scenario.calls, ['cancel']);

  const production = scenarioFor(PRODUCTION_RULES);
  assert.equal(await cancelAndConfirm(production.options), 'stopped');
  assert.deepEqual(production.scenario.calls, ['cancel', 'force']);
});

void test('OTA lane: a publish that starts before the cancel request is not cancelled at all', async () => {
  const oldStart = minutesAgo(DEFAULT_MAX_RUN_MINUTES + 60);
  const scenario = cancellationScenario({
    currentRun: otaRun({ status: 'in_progress', run_started_at: oldStart }),
    currentJobs: [{ name: 'publish', status: 'in_progress', started_at: minutesAgo(1) }],
  });
  assert.equal(await cancelAndConfirm({ ...scenario.options, rules: OTA_RULES }), 'resumed');
  assert.deepEqual(scenario.calls, []);
});

void test('OTA lane: run listings span every branch; production-deploy stays on main', () => {
  const endpointsFor = (branchOptions) => {
    const endpoints = [];
    const github = createCliGitHub({
      repository: 'example/repository',
      ...branchOptions,
      api: (argumentsList) => {
        endpoints.push(argumentsList.find((argument) => argument.startsWith('repos/')));
        return JSON.stringify({ workflow_runs: [] });
      },
    });
    github.listRuns();
    return endpoints;
  };

  const otaEndpoints = endpointsFor({ workflowFile: MOBILE_OTA_LANE.workflowFile, branch: MOBILE_OTA_LANE.branch });
  assert.equal(otaEndpoints.length, 6);
  for (const endpoint of otaEndpoints) {
    assert.match(endpoint, /^repos\/example\/repository\/actions\/workflows\/mobile-ota-production\.yml\/runs\?/);
    assert.doesNotMatch(endpoint, /branch=/);
  }
  assert.ok(otaEndpoints.some((endpoint) => endpoint.includes('status=waiting')));

  for (const endpoint of endpointsFor({ workflowFile: 'production-deploy.yml' })) {
    assert.match(endpoint, /\/runs\?branch=main&/);
  }
});

void test('the CLI picks a lane by name and refuses an unknown one', () => {
  assert.equal(parseCliArguments([]).lane, PRODUCTION_DEPLOY_LANE);
  const ota = parseCliArguments(['--lane', 'mobile-ota-production', '--dry-run']);
  assert.equal(ota.lane, MOBILE_OTA_LANE);
  assert.equal(ota.lane.workflowFile, 'mobile-ota-production.yml');
  assert.equal(ota.dryRun, true);
  assert.throws(() => parseCliArguments(['--lane', 'mobile-ota-staging']), /unknown --lane "mobile-ota-staging"/);
  assert.throws(() => parseCliArguments(['--lane']), /unknown --lane/);
  assert.throws(() => parseCliArguments(['--lane', 'toString']), /unknown --lane/);
});

void test('the lanes differ only where the docs say they do', () => {
  assert.equal(PRODUCTION_DEPLOY_LANE.branch, 'main');
  assert.equal(PRODUCTION_DEPLOY_LANE.maxRunMinutes, DEFAULT_MAX_RUN_MINUTES);
  assert.equal(PRODUCTION_DEPLOY_LANE.redispatch, true);
  assert.equal(MOBILE_OTA_LANE.branch, null);
  assert.equal(MOBILE_OTA_LANE.stallMinutes, DEFAULT_STALL_MINUTES);
  assert.equal(MOBILE_OTA_LANE.maxRunMinutes, null);
  assert.equal(MOBILE_OTA_LANE.runningAlertMinutes, null);
  assert.equal(MOBILE_OTA_LANE.redispatch, false);
  assert.deepEqual([...MOBILE_OTA_LANE.parkedJobStatuses], ['waiting']);
  assert.equal(PRODUCTION_DEPLOY_LANE.forceSettledRunAfterCancel, false);
  assert.equal(MOBILE_OTA_LANE.forceSettledRunAfterCancel, true);
});

void test('the workflow runs one job per lane and never under an environment', () => {
  const source = readFileSync(new URL('../.github/workflows/production-deploy-watchdog.yml', import.meta.url), 'utf8');
  const workflow = parseYaml(source);
  const watchdogJob = workflow.jobs.watchdog;

  assert.deepEqual(watchdogJob.strategy.matrix.lane, Object.keys(LANES));
  assert.equal(watchdogJob.strategy['fail-fast'], false);
  // A watchdog under `environment: Production` would park at the very gate it
  // exists to break.
  for (const job of Object.values(workflow.jobs)) assert.equal(job.environment, undefined);
  assert.doesNotMatch(source, /^\s*environment:/m);
  assert.match(source, /--lane "\$LANE"/);
});

void test('OTA lane: a waiting run with no job listed is never cancelled on run status alone', () => {
  // A run that just left a long `queue: max` wait can read `waiting` before
  // its jobs are listed, and with no jobs the hold start falls back to the
  // trigger time. production-deploy accepts that signal (its ceiling backs it
  // up); the OTA lane needs a job it can see.
  const justReleased = otaRun({ created_at: minutesAgo(10 * 60), run_started_at: minutesAgo(10 * 60) });

  assert.equal(isParked(justReleased, [], MOBILE_OTA_LANE.parkedJobStatuses, false), false);
  assert.equal(classifyRun({ run: justReleased, jobs: [], nowMs: NOW, ...OTA_RULES }).action, 'none');
  assert.equal(classifyRun({ run: justReleased, jobs: undefined, nowMs: NOW, ...OTA_RULES }).action, 'none');
  assert.equal(classifyRun({ run: justReleased, jobs: [], nowMs: NOW, ...PRODUCTION_RULES }).action, 'cancel');
});

void test('OTA lane: the CLI leaves a jobless waiting run alone', async () => {
  const plan = await runCli({
    github: {
      listRuns: () => ({
        runs: [otaRun({ created_at: minutesAgo(10 * 60), run_started_at: minutesAgo(10 * 60) })],
        recentPageOk: true,
      }),
      listJobs: () => [],
      getRun: () => assert.fail('no target, so no confirmation'),
      cancelRun: () => assert.fail('a jobless waiting run is not a target on the OTA lane'),
      dispatchRun: () => assert.fail('the OTA lane never dispatches'),
    },
    lane: MOBILE_OTA_LANE,
    headSha: HEAD_SHA,
    now: () => NOW,
    runUrlBase: '',
    discordFilePath: '',
    outputPath: '',
    dryRun: false,
  });
  assert.equal(plan.cancel.length, 0);
  assert.equal(plan.failed, false);
});

// After the ordinary cancel, the waiting job goes to cancelled but the run
// never reaches `completed`: every job reads finished. `finishedAt` is when
// the cancelled job finished, relative to NOW (the cancel request).
function settledScenario({ rules, finishedAtMs = NOW, jobsAfterCancel } = {}) {
  const scenario = cancellationScenario({ currentRun: otaRun(), currentJobs: octoberWedgeJobs(27 * 60) });
  scenario.github.cancelRun = () => {
    scenario.calls.push('cancel');
    scenario.setRun(otaRun({ status: 'in_progress' }));
    scenario.setJobs(
      jobsAfterCancel ??
        octoberWedgeJobs(27 * 60).map((job) =>
          job.status === 'waiting'
            ? {
                ...job,
                status: 'completed',
                conclusion: 'cancelled',
                completed_at: new Date(finishedAtMs).toISOString(),
              }
            : job,
        ),
    );
  };
  return { scenario, options: { ...scenario.options, rules } };
}

void test('OTA lane: a run our cancel left short of completed is force-cancelled once settled', async () => {
  // classifyRun reads "not parked", and with no ceiling nothing else would ever
  // end it. Every OTA job after the gate is `always() && !cancelled()`, so
  // nothing new starts once the cancel lands.
  const { scenario, options } = settledScenario({ rules: OTA_RULES });
  assert.equal(await cancelAndConfirm(options), 'stopped');
  assert.deepEqual(scenario.calls, ['cancel', 'force']);
  assert.equal(scenario.clock.now() - NOW, CANCEL_GRACE_MS);
});

void test('OTA lane: a job finished under two minutes ago keeps the run out of the force path', async () => {
  // A future `always()` job could be created right after the last one
  // finishes; the quiet window keeps that race shut. The re-check runs
  // CANCEL_GRACE_MS after the cancel request.
  const recheckMs = NOW + CANCEL_GRACE_MS;
  const cases = [
    { quietMs: 2 * 60_000 - 1, expected: 'resumed', calls: ['cancel'] },
    { quietMs: 2 * 60_000, expected: 'stopped', calls: ['cancel', 'force'] },
  ];
  for (const { quietMs, expected, calls } of cases) {
    const { scenario, options } = settledScenario({ rules: OTA_RULES, finishedAtMs: recheckMs - quietMs });
    assert.equal(await cancelAndConfirm(options), expected, `quiet=${String(quietMs)}ms`);
    assert.deepEqual(scenario.calls, calls, `quiet=${String(quietMs)}ms`);
  }
});

void test('OTA lane: an empty job list after the cancel is never read as settled', async () => {
  const { scenario, options } = settledScenario({ rules: OTA_RULES, jobsAfterCancel: [] });
  assert.equal(await cancelAndConfirm(options), 'resumed');
  assert.deepEqual(scenario.calls, ['cancel']);
});

void test('production-deploy: an all-finished snapshot after the cancel is never force-cancelled', async () => {
  // sync-static-assets, build-web, migrate and deploy-production-backend run
  // under `always()` without `!cancelled()`. A snapshot between build-web
  // finishing and migrate being created reads "all finished"; force-cancelling
  // there can kill migrate. This lane keeps main's answer, and its six-hour
  // ceiling stays the backstop. The same shape on the OTA lane IS forced.
  const parked = [
    { name: 'detect-changes', status: 'completed', conclusion: 'success', completed_at: minutesAgo(60) },
    // Waiting at the gate, so both lanes' rules see a cancel target.
    { name: 'sync-static-assets', status: 'waiting', created_at: minutesAgo(60) },
  ];
  const betweenBuildAndMigrate = [
    { name: 'detect-changes', status: 'completed', conclusion: 'success', completed_at: minutesAgo(60) },
    { name: 'sync-static-assets', status: 'completed', conclusion: 'success', completed_at: minutesAgo(1) },
    { name: 'build-web', status: 'completed', conclusion: 'success', completed_at: minutesAgo(0) },
  ];
  for (const [rules, expected, calls] of [
    [PRODUCTION_RULES, 'resumed', ['cancel']],
    [OTA_RULES, 'stopped', ['cancel', 'force']],
  ]) {
    const scenario = cancellationScenario({ currentRun: run({ status: 'in_progress' }), currentJobs: parked });
    scenario.github.cancelRun = () => {
      scenario.calls.push('cancel');
      scenario.setJobs(betweenBuildAndMigrate);
    };
    const result = await cancelAndConfirm({ ...scenario.options, rules });
    assert.equal(result, expected, rules === PRODUCTION_RULES ? 'production' : 'ota');
    assert.deepEqual(scenario.calls, calls);
  }
  // The default rules are production-deploy's, so a caller that passes none
  // gets the safe answer too.
  const scenario = cancellationScenario({ currentRun: run({ status: 'in_progress' }), currentJobs: parked });
  scenario.github.cancelRun = () => {
    scenario.calls.push('cancel');
    scenario.setJobs(betweenBuildAndMigrate);
  };
  assert.equal(await cancelAndConfirm(scenario.options), 'resumed');
});

void test('OTA lane: the CLI never force-cancels a publish older than six hours that resumes mid-cancel', async () => {
  // runCli must hand cancelAndConfirm the lane's rules. With production-deploy's
  // defaults, the six-hour ceiling would force-cancel this publish.
  const clock = fakeClock();
  const mutations = [];
  const oldStart = minutesAgo(7 * 60);
  let resumed = false;
  const discordFilePath = join(mkdtempSync(join(tmpdir(), 'boardsesh-watchdog-')), 'discord.txt');
  const result = await runCli({
    github: {
      listRuns: () => ({ runs: [otaRun({ run_started_at: oldStart, created_at: oldStart })], recentPageOk: true }),
      listJobs: () =>
        resumed
          ? [{ name: 'publish', status: 'in_progress', started_at: new Date(NOW).toISOString() }]
          : [{ name: 'publish', status: 'waiting' }],
      getRun: () =>
        otaRun({ status: resumed ? 'in_progress' : 'waiting', run_started_at: oldStart, created_at: oldStart }),
      cancelRun: () => {
        mutations.push('cancel');
        resumed = true;
      },
      forceCancelRun: () => mutations.push('force'),
      dispatchRun: () => assert.fail('the OTA lane never dispatches'),
    },
    lane: MOBILE_OTA_LANE,
    headSha: HEAD_SHA,
    ...clock,
    runUrlBase: '',
    discordFilePath,
    outputPath: '',
    dryRun: false,
  });
  assert.deepEqual(mutations, ['cancel']);
  assert.equal(result.cancel.length, 0);
  assert.equal(result.followUp, 'none');
  assert.equal(result.failed, false);
  assert.equal(existsSync(discordFilePath), false);
});

void test('OTA lane: a held run whose jobs cannot be read turns the watchdog red, uncancelled', async () => {
  // With no age ceiling there is no backstop for a run the watchdog cannot
  // inspect, so "no stalled mobile OTA run found" would be a false all-clear.
  const parkedForADay = otaRun({ created_at: minutesAgo(27 * 60), run_started_at: minutesAgo(27 * 60) });
  const messages = [];
  const originalConsoleError = console.error;
  console.error = (message) => messages.push(String(message));
  let result;
  try {
    result = await runCli({
      github: {
        listRuns: () => ({ runs: [parkedForADay, otaRun({ id: 9, status: 'pending' })], recentPageOk: true }),
        listJobs: () => null,
        getRun: () => assert.fail('an unreadable run is not a target'),
        cancelRun: () => assert.fail('an unreadable run is never cancelled'),
        dispatchRun: () => assert.fail('the OTA lane never dispatches'),
      },
      lane: MOBILE_OTA_LANE,
      headSha: HEAD_SHA,
      now: () => NOW,
      runUrlBase: '',
      discordFilePath: '',
      outputPath: '',
      dryRun: false,
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(result.failed, true);
  assert.deepEqual(
    result.unreadableRuns.map((unreadable) => unreadable.id),
    [parkedForADay.id],
  );
  const report = messages.join('\n');
  assert.match(report, /could NOT read the job list of run #1101 \(1111111 on release\/next/);
  assert.match(report, /no age ceiling to fall back on/);
  assert.doesNotMatch(report, /no stalled mobile OTA run found/);

  // production-deploy keeps its ceiling as the backstop, so the same gap is
  // not a failure there.
  const production = await runCli({
    github: {
      listRuns: () => ({ runs: [run({ status: 'waiting', run_started_at: minutesAgo(30) })], recentPageOk: true }),
      listJobs: () => null,
      dispatchRun: () => assert.fail('nothing to dispatch'),
    },
    headSha: HEAD_SHA,
    now: () => NOW,
    runUrlBase: '',
    discordFilePath: '',
    outputPath: '',
    dryRun: false,
  });
  assert.deepEqual(production.unreadableRuns, []);
  assert.equal(production.failed, false);
});

void test('a run finishing on its own before the cancel request is not cancelled', async () => {
  // Every job completed, run not yet `completed`: that is a normal finish, and
  // the force path only applies after the watchdog has sent its own cancel.
  const scenario = cancellationScenario({
    currentRun: otaRun({ status: 'in_progress' }),
    currentJobs: octoberWedgeJobs(27 * 60).map((job) =>
      job.status === 'waiting'
        ? { ...job, status: 'completed', conclusion: 'success', completed_at: minutesAgo(0) }
        : job,
    ),
  });
  assert.equal(await cancelAndConfirm({ ...scenario.options, rules: OTA_RULES }), 'resumed');
  assert.deepEqual(scenario.calls, []);
});

void test('OTA lane: the report says whether publish succeeded in each stopped run', () => {
  // Jobs are created only once their needs finish, so a run parked at
  // live-store-runtimes has no publish job listed at all.
  const pastPublish = otaRun({ id: 1, run_number: 1101 });
  const beforePublish = otaRun({
    id: 2,
    run_number: 1102,
    event: 'workflow_dispatch',
    display_title: 'Republish android after native build (abc)',
  });
  const plan = planWatchdogActions({
    runs: [pastPublish, beforePublish],
    jobsByRunId: {
      1: octoberWedgeJobs(27 * 60),
      2: [{ name: 'live-store-runtimes / resolve', status: 'waiting', created_at: minutesAgo(120) }],
    },
    nowMs: NOW,
    lane: MOBILE_OTA_LANE,
  });

  assert.deepEqual(
    plan.cancel.map((entry) => entry.deliverySucceeded),
    [true, false],
  );
  const report = formatDiscordContent(plan, { lane: MOBILE_OTA_LANE });
  assert.match(report, /#1101[^\n]*\n {2}`publish` had already succeeded; only the jobs after it were lost\./);
  assert.match(
    report,
    /#1102[^\n]*\n {2}`publish` did not succeed\. A native republish or the release\/next tip is re-dispatched below; any other run is not retried: dispatch mobile-ota-production\.yml again for this branch/,
  );
  const summary = formatSummary(plan, { lane: MOBILE_OTA_LANE });
  assert.match(summary, /#1101 .*; publish succeeded$/m);
  assert.match(summary, /#1102 .*; publish did not succeed$/m);

  // production-deploy has no delivery job, so its entries and copy are unchanged.
  const productionPlan = planWatchdogActions({
    runs: [run({ id: 7, status: 'waiting', head_sha: HEAD_SHA })],
    jobsByRunId: { 7: [{ name: 'check-rollback', status: 'waiting' }] },
    headSha: HEAD_SHA,
    nowMs: NOW,
  });
  assert.equal('deliverySucceeded' in productionPlan.cancel[0], false);
  assert.doesNotMatch(formatDiscordContent(productionPlan), /publish/);
});

void test('a re-run attempt is timed from its own job creation, not its carried-over job times', () => {
  // Real shape (run 39713346612, attempt 2): every listed job, including those
  // carried over, reports the new attempt and a fresh created_at; carried-over
  // jobs keep their old started_at/completed_at. Here the re-run was requested
  // 3 h ago and queued behind the lane, so run_started_at is 3 h old too.
  const rerun = otaRun({ run_attempt: 2, run_started_at: minutesAgo(180), created_at: minutesAgo(20 * 60) });
  const jobsCreatedAt = (minutes) => [
    {
      name: 'live-store-runtimes / resolve',
      run_attempt: 2,
      status: 'completed',
      conclusion: 'success',
      created_at: minutesAgo(minutes),
      started_at: minutesAgo(20 * 60),
      completed_at: minutesAgo(19 * 60),
    },
    {
      name: 'publish',
      run_attempt: 2,
      status: 'waiting',
      created_at: minutesAgo(minutes),
      started_at: minutesAgo(minutes),
    },
  ];
  assert.equal(classifyRun({ run: rerun, jobs: jobsCreatedAt(1), nowMs: NOW, ...OTA_RULES }).action, 'none');
  // Once the attempt's gate has been stuck 45 minutes, it is a target.
  assert.equal(
    classifyRun({ run: rerun, jobs: jobsCreatedAt(DEFAULT_STALL_MINUTES), nowMs: NOW, ...OTA_RULES }).action,
    'cancel',
  );
});

// ─── mobile-ota-production lane: recovering stranded work ────────────────────

const FINGERPRINT = 'f'.repeat(40);

void test('a republish run name yields its platform and full fingerprint, and nothing else does', () => {
  assert.deepEqual(parseRepublishRunName(`Republish android after native build (${FINGERPRINT})`), {
    platform: 'android',
    fingerprint: FINGERPRINT,
  });
  for (const name of [
    'Production OTA',
    'Stage main OTA',
    `Republish all after native build (${FINGERPRINT})`,
    'Republish ios after native build (abc123)',
    `Republish ios after native build (${FINGERPRINT}) ; rm -rf /`,
    undefined,
  ]) {
    assert.equal(parseRepublishRunName(name), null, String(name));
  }
});

function republishRun(overrides = {}) {
  return run({
    id: 50,
    run_number: 900,
    status: 'in_progress',
    event: 'workflow_dispatch',
    head_branch: 'release/next',
    name: `Republish ios after native build (${FINGERPRINT})`,
    run_started_at: minutesAgo(120),
    updated_at: minutesAgo(60),
    ...overrides,
  });
}

// publish parked at the Production gate for an hour, the one state the OTA
// lane cancels.
const PARKED_PUBLISH_JOBS = [
  {
    name: 'live-store-runtimes / resolve',
    status: 'completed',
    conclusion: 'success',
    created_at: minutesAgo(120),
    started_at: minutesAgo(119),
    completed_at: minutesAgo(118),
  },
  { name: 'publish', status: 'waiting', created_at: minutesAgo(60) },
];

void test('a stopped republish is dispatched again once, unless it already published', () => {
  const stopped = republishRun({ status: 'completed', conclusion: 'cancelled' });
  const decide = (overrides) =>
    decideRepublish({ run: stopped, laneJob: 'publish', finalJobs: [], dispatchedRuns: [], ...overrides });

  assert.deepEqual(decide({}), {
    kind: 'republish',
    action: 'redispatch',
    platform: 'ios',
    fingerprint: FINGERPRINT,
    runId: 50,
    name: stopped.name,
    ref: 'release/next',
    command: `gh workflow run mobile-ota-production.yml --ref release/next -f platform=ios -f expect_fingerprint=${FINGERPRINT}`,
  });
  assert.equal(decide({ run: run({ name: 'Production OTA' }) }).action, 'none');
  assert.equal(
    decide({ finalJobs: [{ name: 'publish', status: 'completed', conclusion: 'success' }] }).action,
    'already-published',
  );
  assert.equal(
    decide({ dispatchedRuns: [stopped, run({ id: 51, name: stopped.name, status: 'queued' })] }).action,
    'replacement-exists',
  );
  assert.equal(
    decide({ dispatchedRuns: [run({ id: 49, name: stopped.name, status: 'completed', conclusion: 'cancelled' })] })
      .action,
    'retry-spent',
  );
  // An earlier republish of the same fingerprint that SUCCEEDED (a forced
  // rebuild) is not a spent retry.
  assert.equal(
    decide({ dispatchedRuns: [run({ id: 49, name: stopped.name, status: 'completed', conclusion: 'success' })] })
      .action,
    'redispatch',
  );
  assert.equal(decide({ finalJobs: null }).action, 'unreadable');
  assert.equal(decide({ dispatchedRuns: null }).action, 'unreadable');
  assert.equal(decide({ run: republishRun({ head_branch: null }) }).action, 'unreadable');
});

const TIP_SHA = '9'.repeat(40);

// Run listings reflect cancellations made earlier in the same tick, as GitHub's do.
function laneGitHub({ holding = [], jobs = {}, dispatched = [], branchRuns = [], tip = TIP_SHA } = {}) {
  const calls = [];
  const observed = new Map(holding.map((holdingRun) => [holdingRun.id, holdingRun]));
  const current = (runs) => runs.map((listed) => observed.get(listed.id) ?? listed);
  return {
    calls,
    listRuns: () => ({ runs: current(holding), recentPageOk: true }),
    listJobs: (runId) => jobs[runId] ?? [],
    getRun: (runId) => observed.get(runId),
    cancelRun: (runId) => {
      calls.push(['cancel', runId]);
      observed.set(runId, { ...observed.get(runId), status: 'completed', conclusion: 'cancelled' });
    },
    forceCancelRun: (runId) => calls.push(['force', runId]),
    listDispatchedRuns: () => current(dispatched),
    getBranchHead: () => tip,
    listBranchRuns: () => current(branchRuns),
    dispatchWorkflow: (ref, inputs) => calls.push(['dispatch', ref, inputs]),
  };
}

async function runLane(publishGitHub, overrides = {}) {
  const workDirectory = mkdtempSync(join(tmpdir(), 'boardsesh-ota-watchdog-'));
  const discordFilePath = join(workDirectory, 'discord.txt');
  const outputPath = join(workDirectory, 'github-output.txt');
  const result = await runCli({
    github: publishGitHub,
    lane: MOBILE_OTA_LANE,
    headSha: '',
    now: () => NOW,
    runUrlBase: 'https://github.com/example/repository/actions/runs',
    discordFilePath,
    outputPath,
    dryRun: false,
    ...overrides,
  });
  return {
    result,
    output: readFileSync(outputPath, 'utf8'),
    discord: existsSync(discordFilePath) ? readFileSync(discordFilePath, 'utf8') : '',
  };
}

void test('the lane watchdog cancels a wedged native republish and dispatches it again on its branch', async () => {
  const github = laneGitHub({ holding: [republishRun()], jobs: { 50: PARKED_PUBLISH_JOBS } });
  const { result, output, discord } = await runLane(github);
  assert.deepEqual(github.calls, [
    ['cancel', 50],
    ['dispatch', 'release/next', { platform: 'ios', expect_fingerprint: FINGERPRINT }],
  ]);
  assert.equal(result.failed, false);
  assert.equal(output, 'notify=true\n');
  assert.match(discord, /Mobile OTA lane unwedged/);
  assert.match(discord, /Re-dispatched "Republish ios after native build/);
  assert.match(discord, /<https:\/\/github\.com\/example\/repository\/actions\/runs\/50>/);
});

void test('the lane watchdog never re-dispatches a wedged push for an older commit', async () => {
  // The tip has moved on, and the tip's own run publishes newer JS.
  const pushRun = republishRun({ event: 'push', name: 'Production OTA' });
  const tipRun = run({ id: 60, event: 'push', name: 'Production OTA', head_sha: TIP_SHA, status: 'pending' });
  const github = laneGitHub({ holding: [pushRun], jobs: { 50: PARKED_PUBLISH_JOBS }, branchRuns: [tipRun, pushRun] });
  const { result, discord } = await runLane(github);
  assert.deepEqual(github.calls, [['cancel', 50]]);
  assert.equal(result.failed, false);
  assert.doesNotMatch(discord, /Re-dispatched|Dispatched a fresh publish|NOT re-dispatched/);
});

void test('a wedged push for the release/next tip is dispatched again once on the branch', async () => {
  // Older pushes already skipped as superseded, so nothing else would publish it.
  const tipRun = republishRun({ event: 'push', name: 'Production OTA', head_sha: TIP_SHA });
  const github = laneGitHub({ holding: [tipRun], jobs: { 50: PARKED_PUBLISH_JOBS }, branchRuns: [tipRun] });
  const { result, discord } = await runLane(github);
  assert.deepEqual(github.calls, [
    ['cancel', 50],
    ['dispatch', 'release/next', {}],
  ]);
  assert.equal(result.failed, false);
  assert.match(discord, /Dispatched a fresh publish for the release\/next tip \(9999999\)/);
});

void test('a wedged tip push whose retry is spent posts the dispatch command and fails', async () => {
  const tipRun = republishRun({ event: 'push', name: 'Production OTA', head_sha: TIP_SHA });
  const earlierDispatch = run({
    id: 45,
    event: 'workflow_dispatch',
    name: 'Production OTA',
    head_sha: TIP_SHA,
    status: 'completed',
    conclusion: 'cancelled',
  });
  const github = laneGitHub({
    holding: [tipRun],
    jobs: { 50: PARKED_PUBLISH_JOBS },
    branchRuns: [tipRun, earlierDispatch],
  });
  const { result, discord } = await runLane(github);
  assert.deepEqual(github.calls, [['cancel', 50]]);
  assert.equal(result.failed, true);
  assert.match(discord, /`gh workflow run mobile-ota-production\.yml --ref release\/next`/);
});

void test('tip recovery acts only on a recently cancelled tip with no publish and no earlier dispatch', () => {
  const cancelledTip = run({ id: 70, event: 'push', head_sha: TIP_SHA, status: 'completed', conclusion: 'cancelled' });
  const decide = (overrides) =>
    decideTipRecovery({
      tip: TIP_SHA,
      branchRuns: [cancelledTip],
      finalJobs: [],
      laneJob: 'publish',
      nowMs: NOW,
      ...overrides,
    });
  assert.equal(decide({}).action, 'redispatch');
  assert.equal(decide({ branchRuns: [] }).action, 'none');
  assert.equal(
    decide({ branchRuns: [cancelledTip, run({ id: 71, head_sha: TIP_SHA, status: 'queued' })] }).action,
    'none',
  );
  assert.equal(
    decide({
      branchRuns: [run({ id: 69, head_sha: TIP_SHA, status: 'completed', conclusion: 'success' }), cancelledTip],
    }).action,
    'none',
  );
  assert.equal(decide({ branchRuns: [{ ...cancelledTip, updated_at: minutesAgo(25 * 60) }] }).action, 'none');
  assert.equal(
    decide({ finalJobs: [{ name: 'publish', status: 'completed', conclusion: 'success' }] }).action,
    'already-published',
  );
  // A republish for the tip is decideRepublish's business, not this one's.
  assert.equal(
    decide({ branchRuns: [{ ...cancelledTip, name: `Republish ios after native build (${FINGERPRINT})` }] }).action,
    'none',
  );
  assert.equal(decide({ tip: null }).action, 'unreadable');
  assert.equal(decide({ finalJobs: null }).action, 'unreadable');
});

void test('a republish cancelled after an earlier tick gave up confirming it is re-dispatched by a later tick', async () => {
  // The cancel landed after the tick that sent it stopped waiting. That tick
  // reported the run as not stopped; this one finds it completed and cancelled.
  const cancelled = republishRun({ status: 'completed', conclusion: 'cancelled', updated_at: minutesAgo(20) });
  const github = laneGitHub({ dispatched: [cancelled], jobs: { 50: PARKED_PUBLISH_JOBS } });
  const { result, output, discord } = await runLane(github);
  assert.deepEqual(github.calls, [['dispatch', 'release/next', { platform: 'ios', expect_fingerprint: FINGERPRINT }]]);
  assert.equal(result.failed, false);
  assert.equal(output, 'notify=true\n');
  assert.match(discord, /Mobile OTA lane recovery/);
});

void test('an old spent retry found by the scan stays quiet', async () => {
  const github = laneGitHub({
    dispatched: [
      republishRun({ id: 50, status: 'completed', conclusion: 'cancelled', updated_at: minutesAgo(20) }),
      republishRun({ id: 40, status: 'completed', conclusion: 'cancelled', updated_at: minutesAgo(200) }),
    ],
  });
  const { result, output } = await runLane(github);
  assert.deepEqual(github.calls, []);
  assert.equal(result.failed, false);
  assert.equal(output, 'notify=false\n');
});

void test('a republish whose cancel is not confirmed is reported and left for the next tick', async () => {
  const github = laneGitHub({ holding: [republishRun()], jobs: { 50: PARKED_PUBLISH_JOBS } });
  github.cancelRun = () => {
    throw new Error('HTTP 403: cancellation denied');
  };
  const { result, discord } = await runLane(github);
  assert.deepEqual(github.calls, []);
  assert.equal(result.failed, true);
  assert.deepEqual(
    result.recoveries.map(({ decision }) => decision.action),
    ['cancel-unconfirmed'],
  );
  assert.match(discord, /still wedged/);
  assert.match(discord, /not confirmed stopped\. Once it is, the next tick re-dispatches it/);
});

void test('a republish whose retry is spent is cancelled, reported with the command, and fails the watchdog', async () => {
  const github = laneGitHub({
    holding: [republishRun()],
    jobs: { 50: PARKED_PUBLISH_JOBS },
    dispatched: [republishRun({ id: 40, status: 'completed', conclusion: 'cancelled' })],
  });
  const { result, discord } = await runLane(github);
  assert.deepEqual(github.calls, [['cancel', 50]]);
  assert.equal(result.failed, true);
  assert.match(discord, /was NOT re-dispatched/);
  assert.match(
    discord,
    new RegExp(
      `gh workflow run mobile-ota-production\\.yml --ref release/next -f platform=ios -f expect_fingerprint=${FINGERPRINT}`,
    ),
  );
});

void test('runs queued behind the lane produce no action and no notification', async () => {
  const github = laneGitHub({
    holding: [republishRun()],
    jobs: { 50: [{ name: 'publish', status: 'pending', created_at: minutesAgo(600) }] },
  });
  const { result, output, discord } = await runLane(github);
  assert.deepEqual(github.calls, []);
  assert.equal(result.failed, false);
  assert.equal(output, 'notify=false\n');
  assert.equal(discord, '');
});

void test('a lane dry run reports what it would do without mutating anything', async () => {
  const github = laneGitHub({ holding: [republishRun()], jobs: { 50: PARKED_PUBLISH_JOBS } });
  github.cancelRun = () => assert.fail('dry run must not cancel');
  github.dispatchWorkflow = () => assert.fail('dry run must not dispatch');
  const { result, output } = await runLane(github, { dryRun: true });
  assert.equal(result.cancel.length, 1);
  assert.equal(result.recoveries[0].decision.action, 'redispatch');
  assert.equal(output, 'notify=false\n');
});

void test('a deploy job waiting on another group is queued behind it, not parked', () => {
  // promote-mobile-ota waits as `pending` on the OTA publish lane. The --lane ota
  // pass watches that lane; this pass must not cancel the deploy for waiting.
  const verdict = classifyRun({
    run: run({ status: 'in_progress', run_started_at: minutesAgo(90) }),
    jobs: [
      { name: 'deploy-web', status: 'completed', conclusion: 'success', completed_at: minutesAgo(80) },
      { name: 'promote-mobile-ota', status: 'pending', started_at: minutesAgo(80) },
    ],
    nowMs: NOW,
  });
  assert.equal(verdict.action, 'none');
  assert.equal(isParked(run({ status: 'in_progress' }), [{ name: 'promote-mobile-ota', status: 'pending' }]), false);
});

// A republish that waited past TRAIN_LIVE_STORE_MAX_AGE_MS for the lane fails
// rather than being cancelled. Its binary is stranded just the same.
function staleEvidenceFailure(overrides = {}, failingStep = STALE_EVIDENCE_STEP) {
  return {
    run: republishRun({ status: 'completed', conclusion: 'failure', updated_at: minutesAgo(10), ...overrides }),
    jobs: [
      {
        name: 'publish',
        status: 'completed',
        conclusion: 'failure',
        steps: [
          { name: 'Read public store runtimes', conclusion: 'success' },
          { name: failingStep, conclusion: 'failure' },
        ],
      },
    ],
  };
}

void test('a republish that failed on stale store evidence is dispatched again once', async () => {
  const failed = staleEvidenceFailure();
  const github = laneGitHub({ dispatched: [failed.run], jobs: { 50: failed.jobs } });
  const { result, output, discord } = await runLane(github);
  assert.deepEqual(github.calls, [['dispatch', 'release/next', { platform: 'ios', expect_fingerprint: FINGERPRINT }]]);
  assert.equal(result.failed, false);
  assert.equal(output, 'notify=true\n');
  assert.match(discord, /Mobile OTA lane recovery/);
  assert.match(discord, /Re-dispatched "Republish ios after native build/);
});

void test('a republish that failed for any other reason is left to its own failure report', async () => {
  const failed = staleEvidenceFailure({}, 'Publish iOS OTA');
  const github = laneGitHub({ dispatched: [failed.run], jobs: { 50: failed.jobs } });
  const { result, output } = await runLane(github);
  assert.deepEqual(github.calls, []);
  assert.equal(result.failed, false);
  assert.equal(output, 'notify=false\n');
});

void test('a fresh stale-evidence failure whose retry is spent posts the command and fails the watchdog', async () => {
  const failed = staleEvidenceFailure();
  const earlier = staleEvidenceFailure({ id: 40, updated_at: minutesAgo(140) }).run;
  const github = laneGitHub({ dispatched: [failed.run, earlier], jobs: { 50: failed.jobs } });
  const { result, discord } = await runLane(github);
  assert.deepEqual(github.calls, []);
  assert.equal(result.failed, true);
  assert.match(discord, /was NOT re-dispatched\*\* \(it already had its one retry\)/);
  assert.match(discord, new RegExp(`--ref release/next -f platform=ios -f expect_fingerprint=${FINGERPRINT}`));
});

void test('an old stale-evidence failure whose retry is spent stays quiet', async () => {
  const failed = staleEvidenceFailure({ updated_at: minutesAgo(180) });
  const earlier = staleEvidenceFailure({ id: 40, updated_at: minutesAgo(300) }).run;
  const github = laneGitHub({ dispatched: [failed.run, earlier], jobs: { 50: failed.jobs } });
  const { result, output } = await runLane(github);
  assert.deepEqual(github.calls, []);
  assert.equal(result.failed, false);
  assert.equal(output, 'notify=false\n');
});

void test('mobile-ota-production.yml refuses stale evidence in the step the watchdog looks for', () => {
  const workflow = parseYaml(
    readFileSync(new URL('../.github/workflows/mobile-ota-production.yml', import.meta.url), 'utf8'),
  );
  const step = workflow.jobs.publish.steps.find((candidate) => candidate.name === STALE_EVIDENCE_STEP);
  assert.ok(step, `publish must keep a step named "${STALE_EVIDENCE_STEP}"`);
  assert.match(step.run, /mobile-release-train-policy\.ts --check-evidence/);
});

function staleTipFailure(overrides = {}, failingStep = STALE_EVIDENCE_STEP) {
  const tipRun = run({
    id: 80,
    event: 'push',
    name: 'Production OTA',
    head_branch: 'release/next',
    head_sha: TIP_SHA,
    status: 'completed',
    conclusion: 'failure',
    updated_at: minutesAgo(10),
    ...overrides,
  });
  const jobs = [
    {
      name: 'publish',
      status: 'completed',
      conclusion: 'failure',
      steps: [{ name: failingStep, conclusion: 'failure' }],
    },
  ];
  return { tipRun, jobs };
}

void test('a tip push that failed on stale store evidence is dispatched again once', async () => {
  // Last in a backlog, so the likeliest run to wait past the evidence limit.
  const { tipRun, jobs } = staleTipFailure();
  const github = laneGitHub({ branchRuns: [tipRun], jobs: { 80: jobs } });
  const { result, output, discord } = await runLane(github);
  assert.deepEqual(github.calls, [['dispatch', 'release/next', {}]]);
  assert.equal(result.failed, false);
  assert.equal(output, 'notify=true\n');
  assert.match(discord, /Dispatched a fresh publish for the release\/next tip/);
});

void test('a tip push that failed for another reason is not dispatched again', async () => {
  const { tipRun, jobs } = staleTipFailure({}, 'Publish iOS OTA');
  const github = laneGitHub({ branchRuns: [tipRun], jobs: { 80: jobs } });
  const { output } = await runLane(github);
  assert.deepEqual(github.calls, []);
  assert.equal(output, 'notify=false\n');
});

void test('a fresh stale-evidence tip failure whose retry is spent posts the command and fails', async () => {
  const { tipRun, jobs } = staleTipFailure();
  const earlierDispatch = run({
    id: 75,
    event: 'workflow_dispatch',
    name: 'Production OTA',
    head_sha: TIP_SHA,
    status: 'completed',
    conclusion: 'failure',
  });
  const github = laneGitHub({ branchRuns: [tipRun, earlierDispatch], jobs: { 80: jobs } });
  const { result, discord } = await runLane(github);
  assert.deepEqual(github.calls, []);
  assert.equal(result.failed, true);
  assert.match(discord, /`gh workflow run mobile-ota-production\.yml --ref release\/next`/);
});

void test('with OTA_LANE_REDISPATCH off the watchdog still cancels but posts the command instead', async () => {
  const github = laneGitHub({ holding: [republishRun()], jobs: { 50: PARKED_PUBLISH_JOBS } });
  const { result, output, discord } = await runLane(github, { redispatchEnabled: false });
  assert.deepEqual(github.calls, [['cancel', 50]]);
  assert.equal(result.failed, false);
  assert.equal(output, 'notify=true\n');
  assert.match(discord, /needs a re-dispatch\*\*, but OTA_LANE_REDISPATCH is off/);
  assert.match(
    discord,
    new RegExp(
      `gh workflow run mobile-ota-production\\.yml --ref release/next -f platform=ios -f expect_fingerprint=${FINGERPRINT}`,
    ),
  );
});

void test('with OTA_LANE_REDISPATCH off a stale tip failure posts its command once fresh, then goes quiet', async () => {
  const fresh = staleTipFailure();
  const freshGitHub = laneGitHub({ branchRuns: [fresh.tipRun], jobs: { 80: fresh.jobs } });
  const freshTick = await runLane(freshGitHub, { redispatchEnabled: false });
  assert.deepEqual(freshGitHub.calls, []);
  assert.equal(freshTick.result.failed, false);
  assert.match(freshTick.discord, /OTA_LANE_REDISPATCH is off/);
  assert.match(freshTick.discord, /`gh workflow run mobile-ota-production\.yml --ref release\/next`/);

  const old = staleTipFailure({ updated_at: minutesAgo(120) });
  const oldGitHub = laneGitHub({ branchRuns: [old.tipRun], jobs: { 80: old.jobs } });
  const oldTick = await runLane(oldGitHub, { redispatchEnabled: false });
  assert.deepEqual(oldGitHub.calls, []);
  assert.equal(oldTick.output, 'notify=false\n');
});

void test('only an explicit off disables re-dispatch', () => {
  assert.equal(redispatchEnabledFrom({}), true);
  assert.equal(redispatchEnabledFrom({ OTA_LANE_REDISPATCH: '' }), true);
  assert.equal(redispatchEnabledFrom({ OTA_LANE_REDISPATCH: 'on' }), true);
  assert.equal(redispatchEnabledFrom({ OTA_LANE_REDISPATCH: 'of' }), true);
  assert.equal(redispatchEnabledFrom({ OTA_LANE_REDISPATCH: 'off' }), false);
  assert.equal(redispatchEnabledFrom({ OTA_LANE_REDISPATCH: ' OFF ' }), false);
});

void test('the OTA lane job reads the OTA_LANE_REDISPATCH repository variable', () => {
  const workflow = parseYaml(
    readFileSync(new URL('../.github/workflows/production-deploy-watchdog.yml', import.meta.url), 'utf8'),
  );
  const step = workflow.jobs.watchdog.steps.find((candidate) => candidate.id === 'watchdog');
  assert.equal(step.env.OTA_LANE_REDISPATCH, '${{ vars.OTA_LANE_REDISPATCH }}');
});

void test('OTA recovery reads and dispatches through the GitHub adapter', () => {
  const requests = [];
  const github = createCliGitHub({
    repository: 'example/repository',
    workflowFile: MOBILE_OTA_LANE.workflowFile,
    branch: MOBILE_OTA_LANE.branch,
    api: (argumentsList) => {
      requests.push(argumentsList);
      return argumentsList[2].includes('/git/ref/')
        ? JSON.stringify({ object: { sha: TIP_SHA } })
        : JSON.stringify({ workflow_runs: [] });
    },
  });
  github.listDispatchedRuns();
  github.listBranchRuns('release/next');
  assert.equal(github.getBranchHead('release/next'), TIP_SHA);
  github.dispatchWorkflow('release/next', { platform: 'ios', expect_fingerprint: FINGERPRINT });
  const base = 'repos/example/repository/actions/workflows/mobile-ota-production.yml';
  assert.deepEqual(requests, [
    ['--method', 'GET', `${base}/runs?event=workflow_dispatch&per_page=30`],
    ['--method', 'GET', `${base}/runs?branch=release%2Fnext&per_page=30`],
    ['--method', 'GET', 'repos/example/repository/git/ref/heads/release/next'],
    [
      '--method',
      'POST',
      `${base}/dispatches`,
      '-f',
      'ref=release/next',
      '-f',
      'inputs[platform]=ios',
      '-f',
      `inputs[expect_fingerprint]=${FINGERPRINT}`,
    ],
  ]);
});
