import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CANCEL_GRACE_MS,
  DEFAULT_MAX_RUN_MINUTES,
  DEFAULT_STALL_MINUTES,
  FORCE_CONFIRM_MS,
  cancelAndConfirm,
  createCliGitHub,
  DISCORD_CONTENT_LIMIT,
  classifyRun,
  formatDiscordContent,
  formatDuration,
  formatSummary,
  isParked,
  planWatchdogActions,
  runCli,
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
