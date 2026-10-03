#!/usr/bin/env node
// Breaks a wedged production-deploy concurrency group.
//
// production-deploy.yml runs under `concurrency: production-deploy` with
// `cancel-in-progress: false`, which is right for a deploy that is actually
// executing. The watchdog still enforces a six-hour ceiling, including during
// migrations. GitHub applies that protection to a run doing nothing too:
// a job parked in the
// `waiting` state on the Production environment gate holds the group exactly
// like a running one, forever (the environment approval timeout is 30 days).
//
// While the group is held, every later push to main queues as `pending` and
// GitHub keeps only the newest one, so nothing ships. Worse, the wedge is
// silent: the parked run never fails, so `notify-failure` never fires and the
// Discord deploy channel stays quiet. That is how main went two days without
// reaching production in August 2026 — one run parked at the environment gate
// after a required-reviewer rule was removed mid-run, and nothing said so.
//
// So this watchdog runs on a schedule and looks for a run that holds the group
// without making progress:
//
//   cancel  — the run has at least one parked job, no job executing, and has
//             not moved in `stallMinutes`, or has held the group for six hours.
//             A confirmed cancellation releases the group so the
//             queued run behind it starts immediately, and detect-changes
//             baselines off the last SUCCESSFUL deploy, so the surviving run
//             redeploys everything the cancelled one would have.
//   alert   — the run is genuinely executing but has been going far longer
//             than a deploy takes, but has not reached the six-hour ceiling.
//   none    — healthy, already finished, or `pending` (queued behind the
//             group). A pending run is the thing we are trying to let through,
//             so it is never a target.
//
// If cancelling empties the group and main still has not deployed, the
// watchdog dispatches a fresh run so the wedge ends in a shipped commit rather
// than an empty queue. It dispatches at most once per head SHA, so a gate that
// stays broken produces one retry and an alert, not a deploy loop.

import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleepTimer } from 'node:timers/promises';

const scriptPath = fileURLToPath(import.meta.url);

const DEFAULT_STALL_MINUTES = 45;
const DEFAULT_RUNNING_ALERT_MINUTES = 150;
const DEFAULT_MAX_RUN_MINUTES = 360;
const CANCEL_GRACE_MS = 5 * 60_000;
const FORCE_CONFIRM_MS = 60_000;
const POLL_INTERVAL_MS = 15_000;
const WATCHDOG_BUDGET_MS = 8 * 60_000;

// Statuses that occupy the concurrency group. `pending` is deliberately absent:
// that is a run queued BEHIND the group, i.e. the run we are freeing.
const HOLDING_RUN_STATUSES = new Set(['waiting', 'queued', 'requested', 'in_progress']);

// Job statuses that mean "has not run any steps yet". `waiting` is the
// environment gate; `queued`/`requested`/`pending` are waiting on a runner.
const PARKED_JOB_STATUSES = new Set(['waiting', 'queued', 'requested', 'pending']);

function isHoldingRun(run) {
  return HOLDING_RUN_STATUSES.has(run?.status ?? '');
}

// GitHub run IDs increase across dispatches. A completed cancellation remains
// evidence for recovery on later ticks, even after a post-cancel API failure.
function isLatestRunCancelled(runs) {
  const latestRun = runs.reduce(
    (latest, run) => (latest === null || Number(run.id) > Number(latest.id) ? run : latest),
    null,
  );
  return latestRun?.status === 'completed' && latestRun.conclusion === 'cancelled';
}

function minutesSince(timestamp, nowMs) {
  const parsedMs = Date.parse(timestamp ?? '');
  if (Number.isNaN(parsedMs)) return null;
  return (nowMs - parsedMs) / 60_000;
}

// Cancellation can change updated_at without any job making progress. Queued
// jobs also receive started_at before a runner exists, so ignore those stamps.
function idleMinutes(run, jobs, nowMs) {
  const timestamps = [run?.run_started_at ?? run?.created_at];
  for (const job of jobs ?? []) {
    if (
      (job.status === 'completed' || job.status === 'in_progress') &&
      job.conclusion !== 'cancelled' &&
      job.conclusion !== 'skipped'
    ) {
      timestamps.push(job.started_at);
      timestamps.push(job.completed_at);
    }
  }
  const progressTimes = timestamps.map((timestamp) => Date.parse(timestamp ?? '')).filter(Number.isFinite);
  return progressTimes.length === 0 ? null : (nowMs - Math.max(...progressTimes)) / 60_000;
}

function ageMinutes(run, nowMs) {
  return minutesSince(run?.run_started_at ?? run?.created_at, nowMs);
}

// "1h 30m" reads better than "90m" in a Discord ping, and a two-day wedge as
// "2d 1h" rather than a five-digit minute count.
function formatDuration(minutes) {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total}m`;
  const hours = Math.floor(total / 60);
  if (hours < 24) {
    const remainder = total % 60;
    return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
  }
  const days = Math.floor(hours / 24);
  const remainderHours = hours % 24;
  return remainderHours === 0 ? `${days}d` : `${days}d ${remainderHours}h`;
}

// A run is parked when something is queued behind a gate and nothing is moving.
// Jobs that already completed do not make it unparked: run #1337 finished
// detect-changes and deploy-app-web, then sat on check-rollback for two days.
function isParked(run, jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    // No job list (a `waiting` run often has none yet). The run status is then
    // the only signal, and `waiting` means the environment gate by definition.
    return run?.status === 'waiting';
  }
  const executing = jobs.some((job) => job?.status === 'in_progress');
  const parked = jobs.some((job) => PARKED_JOB_STATUSES.has(job?.status ?? ''));
  return !executing && parked;
}

function classifyRun({
  run,
  jobs,
  nowMs,
  stallMinutes = DEFAULT_STALL_MINUTES,
  runningAlertMinutes = DEFAULT_RUNNING_ALERT_MINUTES,
  maxRunMinutes = DEFAULT_MAX_RUN_MINUTES,
}) {
  if (!isHoldingRun(run)) return { action: 'none', reason: `status=${run?.status ?? 'unknown'}` };

  const idle = idleMinutes(run, jobs, nowMs);
  const age = ageMinutes(run, nowMs);

  if (age !== null && age >= maxRunMinutes) {
    return {
      action: 'cancel',
      reason: `running for ${formatDuration(age)}, at the ${maxRunMinutes}m maximum`,
      ageMinutes: age,
    };
  }

  if (jobs !== null && isParked(run, jobs)) {
    if (idle === null) return { action: 'none', reason: 'unreadable-timestamps' };
    if (idle < stallMinutes) {
      return { action: 'none', reason: `parked ${formatDuration(idle)}, under the ${stallMinutes}m threshold` };
    }
    return {
      action: 'cancel',
      reason: `parked for ${formatDuration(idle)} with no job executing (holding the concurrency group)`,
      idleMinutes: idle,
    };
  }

  if (age !== null && age > runningAlertMinutes) {
    return {
      action: 'alert',
      reason: `running for ${formatDuration(age)}, longer than the ${runningAlertMinutes}m alert threshold`,
      ageMinutes: age,
    };
  }

  return { action: 'none', reason: 'executing normally' };
}

// One watchdog run's worth of decisions. `runs` is the workflow's recent run
// list (newest first, as the API returns it); `jobsByRunId` maps a run id to its
// jobs, and may omit runs whose jobs we could not read.
function planWatchdogActions({
  runs,
  jobsByRunId = {},
  headSha = '',
  nowMs,
  stallMinutes = DEFAULT_STALL_MINUTES,
  runningAlertMinutes = DEFAULT_RUNNING_ALERT_MINUTES,
  maxRunMinutes = DEFAULT_MAX_RUN_MINUTES,
}) {
  const candidates = Array.isArray(runs) ? runs : [];
  const cancel = [];
  const alert = [];

  for (const run of candidates) {
    const verdict = classifyRun({
      run,
      jobs: jobsByRunId[String(run?.id ?? '')],
      nowMs,
      stallMinutes,
      runningAlertMinutes,
      maxRunMinutes,
    });
    if (verdict.action === 'cancel') cancel.push({ run, ...verdict });
    if (verdict.action === 'alert') alert.push({ run, ...verdict });
  }

  const cancelledIds = new Set(cancel.map((entry) => String(entry.run.id)));
  const recoveringCancelledRun = isLatestRunCancelled(candidates);
  const recoveryNeeded = cancel.length > 0 || recoveringCancelledRun;
  // Anything still holding or queued after the cancels takes over the group, so
  // main ships without our help. `pending` counts here — it is the run we freed.
  const survivorHoldsGroup = candidates.some(
    (run) => !cancelledIds.has(String(run?.id ?? '')) && (isHoldingRun(run) || run?.status === 'pending'),
  );

  // A dispatch we already made for this SHA means the retry has been spent: if
  // that one wedged too, the gate is broken in a way cancelling cannot fix.
  //
  // This cannot tell our dispatch from an operator's own `gh workflow run
  // production-deploy.yml` on the same commit — production-deploy declares no
  // workflow_dispatch inputs, so there is no marker to set. Erring this way is
  // the safe direction: a manual dispatch for the SHA consumes the retry, so a
  // later stall on that commit is cancelled and reported rather than
  // re-dispatched. The operator who is already in the run's page is better
  // placed to decide than a loop is.
  const alreadyRetriedHead =
    headSha !== '' && candidates.some((run) => run?.event === 'workflow_dispatch' && run?.head_sha === headSha);

  const headAlreadyDeployed =
    headSha !== '' &&
    candidates.some((run) => run?.head_sha === headSha && run?.status === 'completed' && run?.conclusion === 'success');

  const redispatch =
    recoveryNeeded && !survivorHoldsGroup && !alreadyRetriedHead && !headAlreadyDeployed && headSha !== '';

  // What happens to main AFTER the cancels — the report is only worth anything
  // if it distinguishes these. Freeing the group and then saying "the queued run
  // takes over" when nothing is queued and the retry is spent would announce a
  // recovery while production sits idle, which is the exact failure this
  // watchdog exists to end.
  let followUp = 'none';
  if (recoveryNeeded) {
    if (survivorHoldsGroup) followUp = 'queued-run-takes-over';
    else if (redispatch) followUp = 'redispatched';
    else if (headAlreadyDeployed) followUp = 'head-already-deployed';
    else followUp = 'needs-intervention';
  }

  return { cancel, alert, redispatch, followUp, recoveringCancelledRun };
}

function describeRun(entry) {
  const { run, reason } = entry;
  const sha = typeof run.head_sha === 'string' ? run.head_sha.slice(0, 7) : 'unknown';
  return `run #${run.run_number ?? run.id} (${sha}, status=${run.status}): ${reason}`;
}

function formatSummary(plan, { dryRun = false, failedCancelIds = new Set(), dispatched = plan.redispatch } = {}) {
  const verb = dryRun ? 'would cancel' : 'stopped';
  const lines = [];
  for (const entry of plan.cancel) {
    const failed = failedCancelIds.has(String(entry.run.id));
    lines.push(`${failed ? 'could NOT cancel' : verb} ${describeRun(entry)}`);
  }
  for (const entry of plan.alert) lines.push(`alerting on ${describeRun(entry)}`);
  if (dispatched) {
    lines.push(
      dryRun ? 'would dispatch a fresh production deploy for main' : 'dispatched a fresh production deploy for main',
    );
  }
  if (plan.followUp === 'needs-intervention') {
    lines.push('main is NOT deploying: nothing is queued and this head sha has no retry left — needs a human');
  }
  if (lines.length === 0) lines.push('no stalled production deploy found');
  return lines.join('\n');
}

// Discord rejects a content field over 2000 characters with a 400, and the
// workflow's post is best-effort — so an oversized message would fail silently,
// which is the failure mode this whole watchdog exists to remove. Cap it and say
// the report was cut; the job summary always carries the full text.
const DISCORD_CONTENT_LIMIT = 2000;
const DISCORD_TRUNCATION_NOTICE = '\n… truncated — the job summary has the full list.';

function capDiscordContent(content) {
  if (content.length <= DISCORD_CONTENT_LIMIT) return content;
  return `${content.slice(0, DISCORD_CONTENT_LIMIT - DISCORD_TRUNCATION_NOTICE.length)}${DISCORD_TRUNCATION_NOTICE}`;
}

const FOLLOW_UP_LINES = {
  'queued-run-takes-over': 'A queued or active deploy remains; no replacement was dispatched.',
  redispatched: 'Dispatched a fresh deploy for the current main.',
  'head-already-deployed': 'Nothing is queued, but the current main already deployed successfully — no action needed.',
  // Both of these are decided AFTER the cancels run, so planWatchdogActions
  // never sets them — runCli does, once it knows what actually landed.
  'cancel-failed': 'No deploy was started: a cancel did not land, so the group may still be held. Retrying next tick.',
  'dispatch-deferred':
    'No replacement deploy was started: run history could not be read or dispatch failed. Retrying next tick.',
  // No @here: the webhook post sets allowed_mentions.parse=[], so a ping would
  // render as inert text and read as louder than it is.
  'needs-intervention':
    "🚨 **main is NOT deploying.** Nothing is queued and this commit's one retry is already spent. Start a deploy manually (`gh workflow run production-deploy.yml`) and check the Production environment gate.",
  none: '',
};

// Discord content. Mirrors the deploy notifications in production-deploy.yml:
// URLs wrapped in <…> so Discord drops the inline preview embed.
function formatDiscordContent(plan, { runUrlBase = '', failedCancelIds = new Set(), followUp = plan.followUp } = {}) {
  if (plan.cancel.length === 0 && plan.alert.length === 0) {
    // Report a recovery attempt without claiming this tick stopped a run.
    // Retry-spent ticks stay quiet rather than notifying every 15 minutes.
    if (plan.recoveringCancelledRun && (followUp === 'redispatched' || followUp === 'dispatch-deferred')) {
      return `🔁 **Production deploy recovery**\n${FOLLOW_UP_LINES[followUp]}`;
    }
    return '';
  }

  const lines = [];
  if (plan.cancel.length > 0) {
    const cancelled = plan.cancel.filter((entry) => !failedCancelIds.has(String(entry.run.id)));
    const failed = plan.cancel.filter((entry) => failedCancelIds.has(String(entry.run.id)));

    // The headline follows the WORST outcome, not the best: if any cancel did
    // not land, a run may still be holding the group, and "unwedged" over a
    // still-wedged deploy is the reassuring-but-wrong reading this watchdog is
    // supposed to make impossible.
    lines.push(failed.length > 0 ? '⚠️ **Production deploy still wedged**' : '🧹 **Production deploy unwedged**');
    for (const entry of cancelled) {
      const sha = typeof entry.run.head_sha === 'string' ? entry.run.head_sha.slice(0, 7) : 'unknown';
      lines.push(`• Stopped run #${entry.run.run_number ?? entry.run.id} (\`${sha}\`) — ${entry.reason}.`);
      if (runUrlBase !== '') lines.push(`  <${runUrlBase}/${entry.run.id}>`);
    }
    // Reported, not omitted: a cancel that did not land may mean the run is
    // still holding the group, which is the one thing an operator needs to know.
    for (const entry of failed) {
      const sha = typeof entry.run.head_sha === 'string' ? entry.run.head_sha.slice(0, 7) : 'unknown';
      lines.push(
        `• Could NOT cancel run #${entry.run.run_number ?? entry.run.id} (\`${sha}\`) — it may still be holding the group. Retrying next tick.`,
      );
      if (runUrlBase !== '') lines.push(`  <${runUrlBase}/${entry.run.id}>`);
    }
    lines.push(FOLLOW_UP_LINES[followUp] ?? FOLLOW_UP_LINES['needs-intervention']);
    lines.push('Check runner availability and Production environment protection rules if stalls repeat.');
  }
  for (const entry of plan.alert) {
    const sha = typeof entry.run.head_sha === 'string' ? entry.run.head_sha.slice(0, 7) : 'unknown';
    lines.push(
      `⏳ **Production deploy still running** — run #${entry.run.run_number ?? entry.run.id} (\`${sha}\`), ${entry.reason}. Not cancelled.`,
    );
    if (runUrlBase !== '') lines.push(`<${runUrlBase}/${entry.run.id}>`);
  }
  return capDiscordContent(lines.join('\n'));
}

// A hung API call would give the watchdog the very failure it exists to break —
// a silent stall, here for the runner's 6-hour job timeout. Every call is bounded.
const GH_API_TIMEOUT_MS = 30_000;
const JOBS_PAGE_SIZE = 100;
const MAX_JOB_PAGES = 5;
const RUNS_PAGE_SIZE = 30;

// Statuses the runs API can filter on that mean "not finished". Queried
// individually so a run holding the group is found however deep the cancelled
// history above it has grown.
// `pending` is here for the survivor check rather than for cancelling — a run
// queued behind the group is never a target. If a future API drops it as a
// filter value, the per-status try/catch swallows the rejection and the recent
// unfiltered page still carries pending runs, so the check degrades rather than
// breaking.
const HOLDING_QUERY_STATUSES = Object.freeze(['waiting', 'queued', 'requested', 'in_progress', 'pending']);

function createCliGitHub({ repository, workflowFile, api, now = Date.now }) {
  let deadlineMs = Infinity;
  const ghApi = (args) => {
    const remainingMs = deadlineMs - now();
    if (remainingMs <= 0) throw new Error('watchdog deadline exceeded');
    if (api) return api(args);
    return execFileSync('gh', ['api', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: Math.max(1, Math.min(GH_API_TIMEOUT_MS, remainingMs)),
    });
  };

  return {
    setDeadline(nextDeadlineMs) {
      deadlineMs = nextDeadlineMs;
    },
    // Two queries, unioned, because a single newest-first page is not enough.
    //
    // Every push that arrives while a run is parked replaces the one pending run
    // and leaves ANOTHER cancelled run in the history above the holder. The
    // August 2026 wedge stacked 17 of those in eight hours; a longer one buries
    // the parked run past any fixed page size, and the watchdog would go blind
    // exactly when it is needed. So the holding runs are fetched by status —
    // the server filters, and no amount of cancelled history can hide them.
    //
    // The recent page is still needed for the dispatch guards, which ask about
    // completed runs for the current head sha. Those are the newest runs by
    // definition: anything that could push them off the page is a run for a
    // NEWER commit, at which point this head is no longer main's head.
    listRuns() {
      const byId = new Map();
      const add = (runs) => {
        for (const run of runs) if (run?.id !== undefined) byId.set(String(run.id), run);
      };

      let statusQueriesOk = true;
      for (const status of HOLDING_QUERY_STATUSES) {
        try {
          add(this.listRunsByStatus(status));
        } catch {
          // Keep discovering candidates, but withhold redispatch on incomplete history.
          statusQueriesOk = false;
        }
      }
      // Isolated like the status queries — but its loss is not free. The
      // dispatch guards (alreadyRetriedHead, headAlreadyDeployed) read completed
      // runs, which only this page carries, so runCli withholds the dispatch
      // rather than firing one it cannot justify.
      let recentPageOk = statusQueriesOk;
      try {
        add(this.listRecentRuns());
      } catch {
        recentPageOk = false;
      }
      return { runs: [...byId.values()], recentPageOk };
    },
    listRunsByStatus(status) {
      const payload = ghApi([
        '--method',
        'GET',
        `repos/${repository}/actions/workflows/${workflowFile}/runs?branch=main&status=${status}&per_page=${RUNS_PAGE_SIZE}`,
      ]);
      const parsed = JSON.parse(payload);
      if (!Array.isArray(parsed?.workflow_runs)) throw new Error('unreadable workflow history');
      return parsed.workflow_runs;
    },
    listRecentRuns() {
      const payload = ghApi([
        '--method',
        'GET',
        `repos/${repository}/actions/workflows/${workflowFile}/runs?branch=main&per_page=${RUNS_PAGE_SIZE}`,
      ]);
      const parsed = JSON.parse(payload);
      if (!Array.isArray(parsed?.workflow_runs)) throw new Error('unreadable workflow history');
      return parsed.workflow_runs;
    },
    // Paginated deliberately. A truncated job list is worse than no list: drop
    // the page holding the one `in_progress` job and isParked reads the run as
    // parked, which cancels a deploy that is actually working.
    listJobs(runId) {
      try {
        const jobs = [];
        for (let page = 1; page <= MAX_JOB_PAGES; page += 1) {
          const payload = ghApi([
            '--method',
            'GET',
            `repos/${repository}/actions/runs/${runId}/jobs?per_page=${JOBS_PAGE_SIZE}&page=${page}`,
          ]);
          const parsed = JSON.parse(payload);
          const pageJobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
          jobs.push(...pageJobs);
          const totalCount = parsed?.total_count;
          if (!Array.isArray(parsed?.jobs) || !Number.isInteger(totalCount) || totalCount < 0) return null;
          if (jobs.length >= totalCount) return jobs;
          if (pageJobs.length === 0) return null;
        }
        return null;
      } catch {
        // Unknown is distinct from a complete empty list. Idle cancellation
        // requires complete jobs; the absolute age ceiling still applies.
        return null;
      }
    },
    getHeadSha() {
      const reference = JSON.parse(ghApi(['--method', 'GET', `repos/${repository}/git/ref/heads/main`]));
      if (typeof reference?.object?.sha !== 'string' || reference.object.sha === '') {
        throw new Error('unreadable main head');
      }
      return reference.object.sha;
    },
    getRun(runId) {
      const run = JSON.parse(ghApi(['--method', 'GET', `repos/${repository}/actions/runs/${runId}`]));
      if (run?.id !== runId || typeof run.status !== 'string') throw new Error('unreadable workflow run');
      return run;
    },
    forceCancelRun(runId) {
      ghApi(['--method', 'POST', `repos/${repository}/actions/runs/${runId}/force-cancel`]);
    },
    cancelRun(runId) {
      ghApi(['--method', 'POST', `repos/${repository}/actions/runs/${runId}/cancel`]);
    },
    dispatchRun(ref) {
      ghApi([
        '--method',
        'POST',
        `repos/${repository}/actions/workflows/${workflowFile}/dispatches`,
        '-f',
        `ref=${ref}`,
      ]);
    },
  };
}

// Both stages require observed completion: a 202 response only acknowledges
// the request. Recheck eligibility before force-cancelling an idle intervention.
async function cancelAndConfirm({ github, runId, now = Date.now, sleep = sleepTimer, deadlineMs }) {
  const requireTime = () => {
    if (now() >= deadlineMs) throw new Error('watchdog deadline exceeded');
  };
  requireTime();
  let run = github.getRun(runId);
  if (run.status === 'completed') return 'stopped';
  const jobs = github.listJobs(runId);
  if (classifyRun({ run, jobs, nowMs: now() }).action !== 'cancel') {
    if (jobs === null) throw new Error('idle cancellation eligibility cannot be confirmed: job list unreadable');
    return 'resumed';
  }
  requireTime();
  try {
    github.cancelRun(runId);
  } catch (error) {
    requireTime();
    if (github.getRun(runId).status === 'completed') return 'stopped';
    // A previous ordinary cancellation may already be pending. A conflict
    // must not prevent escalation forever; other API errors remain failures.
    const conflict = /HTTP\s+409\b/.test(`${error.message}\n${error.stderr ?? ''}`);
    if (!conflict) throw error;
  }

  const waitForCompletion = async (durationMs) => {
    const stageDeadlineMs = Math.min(deadlineMs, now() + durationMs);
    while (true) {
      requireTime();
      run = github.getRun(runId);
      if (run.status === 'completed') return true;
      if (now() >= stageDeadlineMs) return false;
      await sleep(Math.min(POLL_INTERVAL_MS, stageDeadlineMs - now()));
    }
  };
  if (await waitForCompletion(CANCEL_GRACE_MS)) return 'stopped';

  requireTime();
  run = github.getRun(runId);
  if (run.status === 'completed') return 'stopped';
  const freshJobs = github.listJobs(runId);
  if (classifyRun({ run, jobs: freshJobs, nowMs: now() }).action !== 'cancel') {
    if (freshJobs === null) throw new Error('could not read complete job list before force cancellation');
    return 'resumed';
  }
  requireTime();
  try {
    github.forceCancelRun(runId);
  } catch (error) {
    requireTime();
    if (github.getRun(runId).status === 'completed') return 'stopped';
    throw error;
  }
  if (await waitForCompletion(FORCE_CONFIRM_MS)) return 'stopped';
  throw new Error('force cancellation did not reach completed status');
}

async function runCli({
  github,
  headSha,
  nowMs,
  now = Date.now,
  sleep = sleepTimer,
  runUrlBase,
  discordFilePath,
  outputPath,
  dryRun,
}) {
  const deadlineMs = now() + WATCHDOG_BUDGET_MS;
  github.setDeadline?.(deadlineMs);
  const { runs, recentPageOk } = github.listRuns();
  const jobsByRunId = {};
  for (const run of runs) {
    if (isHoldingRun(run)) jobsByRunId[String(run.id)] = github.listJobs(run.id);
  }
  const plannedActions = planWatchdogActions({ runs, jobsByRunId, headSha, nowMs: nowMs ?? now() });
  const failedCancelIds = new Set();
  const resumedIds = new Set();
  const hadCandidates = plannedActions.cancel.length > 0;
  for (const entry of plannedActions.cancel) {
    console.error(`production-deploy-watchdog: ${dryRun ? 'would cancel' : 'cancelling'} ${describeRun(entry)}`);
    if (dryRun) continue;
    try {
      const result = await cancelAndConfirm({ github, runId: entry.run.id, now, sleep, deadlineMs });
      if (result === 'resumed') {
        resumedIds.add(String(entry.run.id));
        console.error(`production-deploy-watchdog: run ${entry.run.id} resumed; cancellation escalation withheld`);
      }
    } catch (error) {
      failedCancelIds.add(String(entry.run.id));
      console.error(`production-deploy-watchdog: could NOT stop ${describeRun(entry)}: ${error.message}`);
    }
  }
  const plan = {
    ...plannedActions,
    cancel: plannedActions.cancel.filter((entry) => !resumedIds.has(String(entry.run.id))),
  };

  let historyOk = recentPageOk;
  if (hadCandidates || plan.recoveringCancelledRun) {
    try {
      const currentHeadSha = github.getHeadSha ? github.getHeadSha() : headSha;
      const freshHistory = github.listRuns();
      if (!freshHistory.recentPageOk) throw new Error('incomplete production deploy history');
      historyOk = true;
      // Recompute follow-up against real state, without pretending planned
      // cancellations have completed. Pending runs may have changed meanwhile.
      const plannedIds = new Set(plan.cancel.map((entry) => String(entry.run.id)));
      const survivor = freshHistory.runs.some(
        (run) => !(dryRun && plannedIds.has(String(run.id))) && (isHoldingRun(run) || run.status === 'pending'),
      );
      const headDeployed = freshHistory.runs.some(
        (run) => run.head_sha === currentHeadSha && run.status === 'completed' && run.conclusion === 'success',
      );
      const retried = freshHistory.runs.some(
        (run) => run.head_sha === currentHeadSha && run.event === 'workflow_dispatch',
      );
      plan.recoveringCancelledRun = isLatestRunCancelled(freshHistory.runs);
      const recoveryStillNeeded = hadCandidates || plan.recoveringCancelledRun;
      plan.redispatch = recoveryStillNeeded && !survivor && !headDeployed && !retried && currentHeadSha !== '';
      plan.followUp = !recoveryStillNeeded
        ? 'none'
        : survivor
          ? 'queued-run-takes-over'
          : headDeployed
            ? 'head-already-deployed'
            : plan.redispatch
              ? 'redispatched'
              : 'needs-intervention';
    } catch (error) {
      historyOk = false;
      console.error(`production-deploy-watchdog: could not refresh run history: ${error.message}`);
    }
  }
  let dispatched = false;
  let dispatchFailed = false;
  if (plan.redispatch && failedCancelIds.size === 0 && historyOk) {
    try {
      if (!dryRun) github.dispatchRun('main');
      dispatched = true;
    } catch (error) {
      dispatchFailed = true;
      console.error(`production-deploy-watchdog: dispatch failed: ${error.message}`);
    }
  }
  if (failedCancelIds.size > 0) plan.followUp = 'cancel-failed';
  else if (!historyOk || dispatchFailed) plan.followUp = 'dispatch-deferred';

  const summary = formatSummary(plan, { dryRun, failedCancelIds, dispatched });
  console.error(`production-deploy-watchdog: ${summary}`);
  const discordContent = dryRun ? '' : formatDiscordContent(plan, { runUrlBase, failedCancelIds });
  if (discordContent !== '' && discordFilePath) writeFileSync(discordFilePath, discordContent, 'utf8');
  if (outputPath) appendFileSync(outputPath, `notify=${discordContent === '' ? 'false' : 'true'}\n`, 'utf8');
  return { ...plan, failed: !dryRun && (failedCancelIds.size > 0 || !historyOk || dispatchFailed) };
}

function parseCliArguments(argv) {
  const options = {
    repository: process.env.GITHUB_REPOSITORY ?? '',
    workflowFile: 'production-deploy.yml',
    headSha: process.env.GITHUB_SHA ?? '',
    runUrlBase: '',
    discordFilePath: '',
    outputPath: process.env.GITHUB_OUTPUT ?? '',
    dryRun: false,
  };

  for (let argumentIndex = 0; argumentIndex < argv.length; argumentIndex += 1) {
    const argument = argv[argumentIndex];
    const optionValue = argv[argumentIndex + 1];
    switch (argument) {
      case '--head':
        options.headSha = optionValue ?? '';
        argumentIndex += 1;
        break;
      case '--discord-file':
        options.discordFilePath = optionValue ?? '';
        argumentIndex += 1;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      default:
        break;
    }
  }

  if (options.repository !== '') {
    options.runUrlBase = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${options.repository}/actions/runs`;
  }
  return options;
}

if (process.argv[1] === scriptPath) {
  try {
    const options = parseCliArguments(process.argv.slice(2));
    const result = await runCli({
      ...options,
      github: createCliGitHub(options),
    });
    if (result.failed) process.exitCode = 1;
  } catch (error) {
    console.error(`production-deploy-watchdog: ${error.message}`);
    process.exit(1);
  }
}

export {
  DISCORD_CONTENT_LIMIT,
  DEFAULT_RUNNING_ALERT_MINUTES,
  DEFAULT_STALL_MINUTES,
  DEFAULT_MAX_RUN_MINUTES,
  CANCEL_GRACE_MS,
  FORCE_CONFIRM_MS,
  cancelAndConfirm,
  classifyRun,
  createCliGitHub,
  formatDiscordContent,
  formatDuration,
  formatSummary,
  isHoldingRun,
  isParked,
  planWatchdogActions,
  runCli,
};
