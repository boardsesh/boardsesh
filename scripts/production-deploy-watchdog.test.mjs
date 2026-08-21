import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_STALL_MINUTES,
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
    run: run({ updated_at: minutesAgo(DEFAULT_STALL_MINUTES - 5) }),
    jobs: [{ name: 'check-rollback', status: 'queued' }],
    nowMs: NOW,
  });

  assert.equal(verdict.action, 'none');
});

void test('never cancels a run with a job actually executing, however long it has run', () => {
  const verdict = classifyRun({
    run: run({ status: 'in_progress', run_started_at: minutesAgo(60 * 24), updated_at: minutesAgo(60 * 24) }),
    jobs: [
      { name: 'migrate', status: 'completed' },
      { name: 'deploy-web', status: 'in_progress' },
    ],
    nowMs: NOW,
  });

  assert.equal(verdict.action, 'alert');
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

  assert.deepEqual(plan, { cancel: [], alert: [], redispatch: false });
  assert.equal(formatSummary(plan), 'no stalled production deploy found');
  assert.equal(formatDiscordContent(plan), '');
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
  assert.match(content, /Production environment gate/);
  assert.match(content, /<https:\/\/example\.test\/actions\/runs\/42>/);
});

void test('the CLI cancels, redispatches and reports through one pass', () => {
  const cancelled = [];
  const dispatched = [];
  const stalled = run({ id: 7, status: 'waiting', head_sha: HEAD_SHA });

  const plan = runCli({
    github: {
      listRuns: () => [stalled],
      listJobs: () => [{ name: 'check-rollback', status: 'waiting' }],
      cancelRun: (runId) => cancelled.push(runId),
      dispatchRun: (ref) => dispatched.push(ref),
    },
    headSha: HEAD_SHA,
    nowMs: NOW,
    runUrlBase: '',
    discordFilePath: '',
    outputPath: '',
    dryRun: false,
  });

  assert.deepEqual(cancelled, [7]);
  assert.deepEqual(dispatched, ['main']);
  assert.equal(plan.cancel.length, 1);
});

void test('a dry run reports the same plan without touching anything', () => {
  const cancelled = [];
  const dispatched = [];
  const workDirectory = mkdtempSync(join(tmpdir(), 'boardsesh-watchdog-'));
  const discordFilePath = join(workDirectory, 'discord.txt');
  const outputPath = join(workDirectory, 'github-output.txt');

  const plan = runCli({
    github: {
      listRuns: () => [run({ id: 7, status: 'waiting', head_sha: HEAD_SHA })],
      listJobs: () => [{ name: 'check-rollback', status: 'waiting' }],
      cancelRun: (runId) => cancelled.push(runId),
      dispatchRun: (ref) => dispatched.push(ref),
    },
    headSha: HEAD_SHA,
    nowMs: NOW,
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

void test('only holding runs cost a jobs lookup', () => {
  const lookedUp = [];

  runCli({
    github: {
      listRuns: () => [
        run({ id: 1, status: 'completed', conclusion: 'success' }),
        run({ id: 2, status: 'pending' }),
        run({ id: 3, status: 'waiting' }),
      ],
      listJobs: (runId) => {
        lookedUp.push(runId);
        return [{ name: 'check-rollback', status: 'waiting' }];
      },
      cancelRun: () => {},
      dispatchRun: () => {},
    },
    headSha: HEAD_SHA,
    nowMs: NOW,
    runUrlBase: '',
    discordFilePath: '',
    outputPath: '',
    dryRun: true,
  });

  assert.deepEqual(lookedUp, [3]);
});
