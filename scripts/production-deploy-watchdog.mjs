#!/usr/bin/env node
// Breaks a wedged production-deploy concurrency group.
//
// production-deploy.yml runs under `concurrency: production-deploy` with
// `cancel-in-progress: false`, which is right for a deploy that is actually
// executing — you never want to kill a run mid-migration. But GitHub applies
// that protection to a run that is doing nothing too: a job parked in the
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
//             not moved in `stallMinutes`. Cancelling it costs nothing: the
//             queued run behind it starts immediately, and detect-changes
//             baselines off the last SUCCESSFUL deploy, so the surviving run
//             redeploys everything the cancelled one would have.
//   alert   — the run is genuinely executing but has been going far longer
//             than a deploy takes. Never cancelled; a human decides.
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

const scriptPath = fileURLToPath(import.meta.url);

const DEFAULT_STALL_MINUTES = 45;
const DEFAULT_RUNNING_ALERT_MINUTES = 150;

// Statuses that occupy the concurrency group. `pending` is deliberately absent:
// that is a run queued BEHIND the group, i.e. the run we are freeing.
const HOLDING_RUN_STATUSES = new Set(['waiting', 'queued', 'requested', 'in_progress']);

// Job statuses that mean "has not run any steps yet". `waiting` is the
// environment gate; `queued`/`requested`/`pending` are waiting on a runner.
const PARKED_JOB_STATUSES = new Set(['waiting', 'queued', 'requested', 'pending']);

function isHoldingRun(run) {
  return HOLDING_RUN_STATUSES.has(run?.status ?? '');
}

function minutesSince(timestamp, nowMs) {
  const parsedMs = Date.parse(timestamp ?? '');
  if (Number.isNaN(parsedMs)) return null;
  return (nowMs - parsedMs) / 60_000;
}

// How long the run has shown no sign of life. `updated_at` moves whenever a job
// starts or finishes, so it measures idleness rather than total duration — a
// long build is busy, not idle.
function idleMinutes(run, nowMs) {
  return minutesSince(run?.updated_at ?? run?.run_started_at ?? run?.created_at, nowMs);
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
}) {
  if (!isHoldingRun(run)) return { action: 'none', reason: `status=${run?.status ?? 'unknown'}` };

  const idle = idleMinutes(run, nowMs);
  const age = ageMinutes(run, nowMs);

  if (isParked(run, jobs)) {
    if (idle === null) return { action: 'none', reason: 'unreadable-timestamps' };
    if (idle <= stallMinutes) {
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
    });
    if (verdict.action === 'cancel') cancel.push({ run, ...verdict });
    if (verdict.action === 'alert') alert.push({ run, ...verdict });
  }

  const cancelledIds = new Set(cancel.map((entry) => String(entry.run.id)));
  // Anything still holding or queued after the cancels takes over the group, so
  // main ships without our help. `pending` counts here — it is the run we freed.
  const survivorHoldsGroup = candidates.some(
    (run) => !cancelledIds.has(String(run?.id ?? '')) && (isHoldingRun(run) || run?.status === 'pending'),
  );

  // A dispatch we already made for this SHA means the retry has been spent: if
  // that one wedged too, the gate is broken in a way cancelling cannot fix.
  const alreadyRetriedHead =
    headSha !== '' && candidates.some((run) => run?.event === 'workflow_dispatch' && run?.head_sha === headSha);

  const headAlreadyDeployed =
    headSha !== '' &&
    candidates.some((run) => run?.head_sha === headSha && run?.status === 'completed' && run?.conclusion === 'success');

  const redispatch =
    cancel.length > 0 && !survivorHoldsGroup && !alreadyRetriedHead && !headAlreadyDeployed && headSha !== '';

  return { cancel, alert, redispatch };
}

function describeRun(entry) {
  const { run, reason } = entry;
  const sha = typeof run.head_sha === 'string' ? run.head_sha.slice(0, 7) : 'unknown';
  return `run #${run.run_number ?? run.id} (${sha}, status=${run.status}): ${reason}`;
}

function formatSummary(plan, { dryRun = false } = {}) {
  const verb = dryRun ? 'would cancel' : 'cancelled';
  const lines = [];
  for (const entry of plan.cancel) lines.push(`${verb} ${describeRun(entry)}`);
  for (const entry of plan.alert) lines.push(`alerting on ${describeRun(entry)}`);
  if (plan.redispatch) {
    lines.push(
      dryRun ? 'would dispatch a fresh production deploy for main' : 'dispatched a fresh production deploy for main',
    );
  }
  if (lines.length === 0) lines.push('no stalled production deploy found');
  return lines.join('\n');
}

// Discord content. Mirrors the deploy notifications in production-deploy.yml:
// URLs wrapped in <…> so Discord drops the inline preview embed.
function formatDiscordContent(plan, { runUrlBase = '' } = {}) {
  if (plan.cancel.length === 0 && plan.alert.length === 0) return '';

  const lines = [];
  if (plan.cancel.length > 0) {
    lines.push('🧹 **Production deploy unwedged**');
    for (const entry of plan.cancel) {
      const sha = typeof entry.run.head_sha === 'string' ? entry.run.head_sha.slice(0, 7) : 'unknown';
      lines.push(`• Cancelled run #${entry.run.run_number ?? entry.run.id} (\`${sha}\`) — ${entry.reason}.`);
      if (runUrlBase !== '') lines.push(`  <${runUrlBase}/${entry.run.id}>`);
    }
    lines.push(
      plan.redispatch
        ? 'Dispatched a fresh deploy for the current main.'
        : 'The queued run behind it now has the group and will deploy the latest main.',
    );
    lines.push(
      'A run parks like this when the Production environment gate holds a job — check the environment protection rules if it repeats.',
    );
  }
  for (const entry of plan.alert) {
    const sha = typeof entry.run.head_sha === 'string' ? entry.run.head_sha.slice(0, 7) : 'unknown';
    lines.push(
      `⏳ **Production deploy still running** — run #${entry.run.run_number ?? entry.run.id} (\`${sha}\`), ${entry.reason}. Not cancelled.`,
    );
    if (runUrlBase !== '') lines.push(`<${runUrlBase}/${entry.run.id}>`);
  }
  return lines.join('\n');
}

// A hung API call would give the watchdog the very failure it exists to break —
// a silent stall, here for the runner's 6-hour job timeout. Every call is bounded.
const GH_API_TIMEOUT_MS = 30_000;
const JOBS_PAGE_SIZE = 100;
const MAX_JOB_PAGES = 5;

function createCliGitHub({ repository, workflowFile }) {
  const ghApi = (args) =>
    execFileSync('gh', ['api', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GH_API_TIMEOUT_MS,
    });

  return {
    listRuns() {
      // One page is enough: a parked run holds the group, so every later push
      // sits behind it as `pending` and both are near the top of a newest-first
      // list. A stall older than 30 main runs would need the group to have been
      // free in between, which is the case where nothing is wedged.
      const payload = ghApi([
        '--method',
        'GET',
        `repos/${repository}/actions/workflows/${workflowFile}/runs?branch=main&per_page=30`,
      ]);
      const parsed = JSON.parse(payload);
      return Array.isArray(parsed?.workflow_runs) ? parsed.workflow_runs : [];
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
          const totalCount = Number(parsed?.total_count ?? jobs.length);
          if (pageJobs.length === 0 || !Number.isFinite(totalCount) || jobs.length >= totalCount) break;
        }
        return jobs;
      } catch {
        // A run whose jobs we cannot read falls back to its own status in
        // isParked. That is safe in both directions: an executing run is not
        // `waiting`, so it is never cancelled on a missing list, and a `waiting`
        // run is parked at the gate by GitHub's own definition.
        return [];
      }
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

function runCli({ github, headSha, nowMs, runUrlBase, discordFilePath, outputPath, dryRun }) {
  const runs = github.listRuns();
  const jobsByRunId = {};
  for (const run of runs) {
    if (isHoldingRun(run)) jobsByRunId[String(run.id)] = github.listJobs(run.id);
  }

  const plan = planWatchdogActions({ runs, jobsByRunId, headSha, nowMs });

  for (const entry of plan.cancel) {
    console.error(`production-deploy-watchdog: ${dryRun ? 'would cancel' : 'cancelling'} ${describeRun(entry)}`);
    if (!dryRun) github.cancelRun(entry.run.id);
  }
  if (plan.redispatch) {
    console.error(
      `production-deploy-watchdog: ${dryRun ? 'would dispatch' : 'dispatching'} a fresh production deploy for main`,
    );
    if (!dryRun) github.dispatchRun('main');
  }

  const summary = formatSummary(plan, { dryRun });
  console.error(`production-deploy-watchdog: ${summary}`);

  // A dry run reports; it never pings Discord about work it did not do.
  const discordContent = dryRun ? '' : formatDiscordContent(plan, { runUrlBase });
  if (discordContent !== '' && discordFilePath) writeFileSync(discordFilePath, discordContent, 'utf8');
  if (outputPath) {
    appendFileSync(outputPath, `notify=${discordContent === '' ? 'false' : 'true'}\n`, 'utf8');
  }

  return plan;
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
    runCli({
      ...options,
      github: createCliGitHub(options),
      nowMs: Date.now(),
    });
  } catch (error) {
    console.error(`production-deploy-watchdog: ${error.message}`);
    process.exit(1);
  }
}

export {
  DEFAULT_RUNNING_ALERT_MINUTES,
  DEFAULT_STALL_MINUTES,
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
