#!/usr/bin/env node
// Breaks a wedged deploy concurrency group. One script, two lanes (LANES below):
//
//   production-deploy      production-deploy.yml runs on main.
//   mobile-ota-production  mobile-ota-production.yml runs on every branch.
//
// Both workflows run under `cancel-in-progress: false`, which is right for a run
// that is actually executing. GitHub applies that protection to a run doing
// nothing too: a job parked in the `waiting` state on the Production
// environment gate holds the group exactly like a running one, forever (the
// environment approval timeout is 30 days).
//
// While production-deploy is held, every later push to main queues as
// `pending` and GitHub keeps only the newest one, so nothing ships. Worse, the
// wedge is silent: the parked run never fails, so `notify-failure` never fires
// and the Discord deploy channel stays quiet. That is how main went two days
// without reaching production in August 2026 — one run parked at the
// environment gate after a required-reviewer rule was removed mid-run, and
// nothing said so.
//
// The OTA lane wedged the same way in October 2026. Run 40105607795 (a
// release/next push) finished `publish`, then its notify-train-deployment job —
// a Discord post — sat at the Production gate for 27 hours. The lane is
// `queue: max`, so 40 later runs queued behind it, along with the daily stable
// OTA tick and production-deploy's promote-mobile-ota job, which take the same
// group. Nothing alerted.
//
// So this watchdog runs on a schedule and looks for a run that holds the group
// without making progress:
//
//   cancel  — the run has at least one parked job, no job executing, and has
//             not moved in `stallMinutes`. On production-deploy, also any run
//             that has held the group for six hours. A confirmed cancellation
//             releases the group so the queued run behind it starts
//             immediately. On production-deploy, detect-changes baselines off
//             the last SUCCESSFUL deploy, so the surviving run redeploys
//             everything the cancelled one would have.
//   alert   — production-deploy only: the run is genuinely executing and has
//             been going far longer than a deploy takes, but has not reached
//             the six-hour ceiling.
//   none    — healthy, already finished, or `pending` (queued behind the
//             group). A pending run is the thing we are trying to let through,
//             so it is never a target.
//
// If cancelling empties production-deploy's group and main still has not
// deployed, the watchdog dispatches a fresh run so the wedge ends in a shipped
// commit rather than an empty queue. It dispatches at most once per head SHA,
// so a gate that stays broken produces one retry and an alert, not a deploy
// loop. The OTA lane does not re-dispatch the runs it cancels: `queue: max`
// keeps every pending run, so the queue drains by itself once the group frees.
// What it does re-dispatch, once each, is the work nothing queued would redo
// (see recoverStrandedOtaRuns): a native build's republish that was cancelled
// or refused stale store evidence, and the release/next tip, whose older pushes
// skip their publish as superseded. OTA_LANE_REDISPATCH=off turns those into
// posted commands.

import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleepTimer } from 'node:timers/promises';

const scriptPath = fileURLToPath(import.meta.url);

const DEFAULT_STALL_MINUTES = 45;
const DEFAULT_RUNNING_ALERT_MINUTES = 150;
const DEFAULT_MAX_RUN_MINUTES = 360;
const CANCEL_GRACE_MS = 5 * 60_000;
// How long every job must have been finished before a run that our cancel left
// short of `completed` counts as settled (see MOBILE_OTA_LANE).
const SETTLED_QUIET_MS = 2 * 60_000;
const FORCE_CONFIRM_MS = 60_000;
const POLL_INTERVAL_MS = 15_000;
const WATCHDOG_BUDGET_MS = 8 * 60_000;

// Statuses that occupy the concurrency group. `pending` is deliberately absent:
// that is a run queued BEHIND the group, i.e. the run we are freeing.
const HOLDING_RUN_STATUSES = new Set(['waiting', 'queued', 'requested', 'in_progress']);

// Job statuses that mean "has not run any steps yet". `waiting` is the
// environment gate; `queued`/`requested` are waiting on a runner. A `pending`
// job is waiting on a job-level concurrency group, i.e. queued behind another
// run, so it is not parked. In production-deploy that is promote-mobile-ota
// waiting on the OTA publish lane, which the mobile-ota-production lane
// watches; counting it as parked cancelled a deploy that waited 45 minutes
// behind a long publish.
const PARKED_JOB_STATUSES = new Set(['waiting', 'queued', 'requested']);

// Discord copy for production-deploy, keyed by planWatchdogActions' followUp.
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

const OTA_FOLLOW_UP_LINES = {
  'queue-resumes': 'Runs queued behind it keep their place (`queue: max`) and start on their own.',
  'cancel-failed': 'A cancel did not land, so the lane may still be held. Retrying next tick.',
  none: '',
};

// What differs between the two lanes. Everything else — job-list pagination,
// the cancel/force-cancel ladder, verified completion, the eight-minute budget
// and the 30-second API timeouts — is shared.
const PRODUCTION_DEPLOY_LANE = Object.freeze({
  name: 'production-deploy',
  workflowFile: 'production-deploy.yml',
  // Only main deploys production.
  branch: 'main',
  // A job queued for a runner counts too: a `runs-on` label that never comes
  // online holds the group exactly like the environment gate does.
  parkedJobStatuses: PARKED_JOB_STATUSES,
  // A `waiting` run with no job list yet counts as parked; the six-hour
  // ceiling is the backstop if that reading is ever wrong.
  parkedWithoutJobs: true,
  stallMinutes: DEFAULT_STALL_MINUTES,
  runningAlertMinutes: DEFAULT_RUNNING_ALERT_MINUTES,
  maxRunMinutes: DEFAULT_MAX_RUN_MINUTES,
  // Never force-cancel just because every listed job has finished.
  // sync-static-assets, build-web, migrate and deploy-production-backend run
  // under `always()` without `!cancelled()`, so they keep going after an
  // ordinary cancel; a snapshot between build-web finishing and migrate being
  // created reads "all finished", and force-cancelling then can kill migrate.
  // The six-hour ceiling is this lane's backstop for a cancel that never lands.
  forceSettledRunAfterCancel: false,
  redispatch: true,
  recovery: false,
  deliveryJobName: null,
  copy: {
    quiet: 'no stalled production deploy found',
    unwedged: '🧹 **Production deploy unwedged**',
    stillWedged: '⚠️ **Production deploy still wedged**',
    stillRunning: '⏳ **Production deploy still running**',
    recovery: '🔁 **Production deploy recovery**',
    checkGate: 'Check runner availability and Production environment protection rules if stalls repeat.',
    followUps: FOLLOW_UP_LINES,
    // The loudest line: an unknown follow-up must never read as a recovery.
    unknownFollowUp: 'needs-intervention',
  },
});

const MOBILE_OTA_LANE = Object.freeze({
  name: 'mobile-ota-production',
  workflowFile: 'mobile-ota-production.yml',
  // release/next pushes and dispatches on main or release/next all take the
  // same `mobile-ota-production` group, so every branch is in scope.
  branch: null,
  // Only the environment gate. A job queued for a runner clears on its own, and
  // cancelling it throws away that run's publish — for a per-platform
  // "Republish … after native build" dispatch, nothing re-sends it.
  parkedJobStatuses: new Set(['waiting']),
  // And only a job the watchdog can see. A run that just left a long
  // `queue: max` wait can read `waiting` before its jobs are listed, and with no
  // jobs its hold start falls back to the trigger time — hours ago. With no
  // age ceiling behind it, the run status alone must never authorise a cancel.
  parkedWithoutJobs: false,
  stallMinutes: DEFAULT_STALL_MINUTES,
  // No age limits, on purpose. Killing an executing publish part-way can leave
  // iOS published and Android not, or the production canary already unlocked
  // for a publish that never lands, and GitHub's own `timeout-minutes` (240 on
  // `publish`) already bounds every executing job in that workflow. The gap
  // GitHub leaves is the parked job, whose clock never starts — the idle rule
  // covers that. The run's age is also a poor signal in a `queue: max` lane: a
  // run can wait hours in the queue before it starts.
  runningAlertMinutes: null,
  maxRunMinutes: null,
  // With no ceiling, a run our cancel left short of `completed` — every job
  // finished, nothing executing — would hold the lane forever, so force it.
  // Safe here because every job after the gate uses `always() && !cancelled()`,
  // so nothing new starts once the cancel lands; the newest job must also have
  // finished SETTLED_QUIET_MS ago, so a future `always()` job cannot reopen the
  // race production-deploy has.
  forceSettledRunAfterCancel: true,
  // `queue: max` keeps every pending run, so the run this lane cancels is never
  // re-dispatched as such...
  redispatch: false,
  // ...but a native republish or the release/next tip that nothing queued
  // would redo is (recoverStrandedOtaRuns).
  recovery: true,
  // Jobs are created only once their `needs` finish, so a run parked at
  // `live-store-runtimes / resolve` has no publish job listed at all. The report
  // says outright whether this job succeeded, rather than leaving the operator
  // to infer it from the parked-job list.
  deliveryJobName: 'publish',
  copy: {
    quiet: 'no stalled mobile OTA run found',
    unwedged: '🧹 **Mobile OTA lane unwedged**',
    stillWedged: '⚠️ **Mobile OTA lane still wedged**',
    // Unreachable while runningAlertMinutes is null; kept so the copy reads
    // right if the lane ever gains an alert.
    stillRunning: '⏳ **Mobile OTA run still running**',
    recovery: '🔁 **Mobile OTA lane recovery**',
    checkGate: 'Check the Production environment protection rules if stalls repeat.',
    followUps: OTA_FOLLOW_UP_LINES,
    unknownFollowUp: 'cancel-failed',
  },
});

const LANES = Object.freeze({
  [PRODUCTION_DEPLOY_LANE.name]: PRODUCTION_DEPLOY_LANE,
  [MOBILE_OTA_LANE.name]: MOBILE_OTA_LANE,
});

// The decision rules a lane implies: classifyRun's options, plus the cancel
// ladder's force rule. cancelAndConfirm re-checks with the same rules, so a
// lane without an age ceiling never gains one mid-cancel.
function laneRules(lane) {
  return {
    stallMinutes: lane.stallMinutes,
    runningAlertMinutes: lane.runningAlertMinutes,
    maxRunMinutes: lane.maxRunMinutes,
    parkedJobStatuses: lane.parkedJobStatuses,
    parkedWithoutJobs: lane.parkedWithoutJobs,
    forceSettledRunAfterCancel: lane.forceSettledRunAfterCancel,
  };
}

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

// When the run began holding the group. `run_started_at` alone is not that: for
// a run that queued behind the group it is the trigger time. On 2026-10-25 a
// mobile-ota-production dispatch created at 05:25 was released at 18:31 and
// still reported run_started_at 05:25 — measured from there, it was 13 hours
// old a minute into its publish. GitHub creates a run's jobs only once it
// leaves the queue, so the earliest job's created_at is the real start.
// Cancellation can add later jobs but never an earlier one, so it cannot move
// this forward. A re-run attempt lists every job, including the ones it carried
// over, with the new attempt number and a fresh created_at (carried-over jobs
// keep their old started_at/completed_at — run 39713346612, attempt 2), so the
// earliest created_at dates the attempt. The max() never lets the hold start
// before run_started_at.
function holdStartMs(run, jobs) {
  const runStartMs = Date.parse(run?.run_started_at ?? run?.created_at ?? '');
  const jobCreatedTimes = (Array.isArray(jobs) ? jobs : [])
    .map((job) => Date.parse(job?.created_at ?? ''))
    .filter(Number.isFinite);
  const firstJobCreatedMs = jobCreatedTimes.length > 0 ? Math.min(...jobCreatedTimes) : Number.NaN;
  const startTimes = [runStartMs, firstJobCreatedMs].filter(Number.isFinite);
  return startTimes.length === 0 ? null : Math.max(...startTimes);
}

// Cancellation can change updated_at without any job making progress. Queued
// jobs also receive started_at before a runner exists, so ignore those stamps.
function idleMinutes(run, jobs, nowMs) {
  const progressTimes = [holdStartMs(run, jobs)];
  for (const job of jobs ?? []) {
    if (
      (job.status === 'completed' || job.status === 'in_progress') &&
      job.conclusion !== 'cancelled' &&
      job.conclusion !== 'skipped'
    ) {
      progressTimes.push(Date.parse(job.started_at ?? ''));
      progressTimes.push(Date.parse(job.completed_at ?? ''));
    }
  }
  const readableTimes = progressTimes.filter(Number.isFinite);
  return readableTimes.length === 0 ? null : (nowMs - Math.max(...readableTimes)) / 60_000;
}

function ageMinutes(run, jobs, nowMs) {
  const startMs = holdStartMs(run, jobs);
  return startMs === null ? null : (nowMs - startMs) / 60_000;
}

// "notify-train-deployment (waiting)" — which gate to look at, and on the OTA
// lane, which work the stopped run never did.
const PARKED_JOB_NAME_LIMIT = 3;

function describeParkedJobs(jobs, parkedJobStatuses) {
  const parkedJobs = (Array.isArray(jobs) ? jobs : []).filter((job) => parkedJobStatuses.has(job?.status ?? ''));
  if (parkedJobs.length === 0) return '';
  const names = parkedJobs
    .slice(0, PARKED_JOB_NAME_LIMIT)
    .map((job) => `${String(job.name ?? 'unnamed job').replace(/[\r\n`]/g, ' ')} (${job.status})`);
  if (parkedJobs.length > PARKED_JOB_NAME_LIMIT) names.push(`+${parkedJobs.length - PARKED_JOB_NAME_LIMIT} more`);
  return `; parked: ${names.join(', ')}`;
}

function minutesSince(timestamp, nowMs) {
  const parsedMs = Date.parse(timestamp ?? '');
  if (Number.isNaN(parsedMs)) return null;
  return (nowMs - parsedMs) / 60_000;
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
// Run 40105607795 finished publish, then sat on notify-train-deployment.
function isParked(run, jobs, parkedJobStatuses = PARKED_JOB_STATUSES, parkedWithoutJobs = true) {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    // No job list (a `waiting` run often has none yet). The run status is then
    // the only signal, and `waiting` means the environment gate by definition —
    // on a lane that accepts that signal (see MOBILE_OTA_LANE for one that doesn't).
    return parkedWithoutJobs && run?.status === 'waiting';
  }
  const executing = jobs.some((job) => job?.status === 'in_progress');
  const parked = jobs.some((job) => parkedJobStatuses.has(job?.status ?? ''));
  return !executing && parked;
}

function classifyRun({
  run,
  jobs,
  nowMs,
  stallMinutes = DEFAULT_STALL_MINUTES,
  runningAlertMinutes = DEFAULT_RUNNING_ALERT_MINUTES,
  maxRunMinutes = DEFAULT_MAX_RUN_MINUTES,
  parkedJobStatuses = PARKED_JOB_STATUSES,
  parkedWithoutJobs = true,
}) {
  if (!isHoldingRun(run)) return { action: 'none', reason: `status=${run?.status ?? 'unknown'}` };

  const idle = idleMinutes(run, jobs, nowMs);
  const age = ageMinutes(run, jobs, nowMs);

  // A lane opts out of an age limit with null (see MOBILE_OTA_LANE). Checked
  // explicitly: `age >= null` is `age >= 0`, which would cancel everything.
  if (Number.isFinite(maxRunMinutes) && age !== null && age >= maxRunMinutes) {
    return {
      action: 'cancel',
      reason: `running for ${formatDuration(age)}, at the ${maxRunMinutes}m maximum`,
      ageMinutes: age,
    };
  }

  if (jobs !== null && isParked(run, jobs, parkedJobStatuses, parkedWithoutJobs)) {
    if (idle === null) return { action: 'none', reason: 'unreadable-timestamps' };
    if (idle < stallMinutes) {
      return { action: 'none', reason: `parked ${formatDuration(idle)}, under the ${stallMinutes}m threshold` };
    }
    return {
      action: 'cancel',
      reason: `parked for ${formatDuration(idle)} with no job executing (holding the concurrency group)${describeParkedJobs(jobs, parkedJobStatuses)}`,
      idleMinutes: idle,
    };
  }

  if (Number.isFinite(runningAlertMinutes) && age !== null && age > runningAlertMinutes) {
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
function planWatchdogActions({ runs, jobsByRunId = {}, headSha = '', nowMs, lane = PRODUCTION_DEPLOY_LANE }) {
  const candidates = Array.isArray(runs) ? runs : [];
  const rules = laneRules(lane);
  const cancel = [];
  const alert = [];

  for (const run of candidates) {
    const jobs = jobsByRunId[String(run?.id ?? '')];
    const verdict = classifyRun({ run, jobs, nowMs, ...rules });
    if (verdict.action === 'cancel') cancel.push({ run, ...verdict, ...deliveryState(jobs, lane) });
    if (verdict.action === 'alert') alert.push({ run, ...verdict });
  }

  // The OTA lane is `queue: max`: every pending run keeps its place and starts
  // once the group frees, so there is no successor to check and nothing to
  // dispatch. The recovery rules below exist because production-deploy keeps
  // only ONE pending run and can end a wedge with an empty queue.
  if (!lane.redispatch) {
    return {
      cancel,
      alert,
      redispatch: false,
      followUp: cancel.length > 0 ? 'queue-resumes' : 'none',
      recoveringCancelledRun: false,
    };
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

// Whether the lane's delivery job (OTA: `publish`) succeeded in a run being
// stopped. A cancel never retries it, so the report has to say.
function deliveryState(jobs, lane) {
  if (lane.deliveryJobName === null) return {};
  const deliverySucceeded =
    Array.isArray(jobs) &&
    jobs.some(
      (job) => job?.name === lane.deliveryJobName && job.status === 'completed' && job.conclusion === 'success',
    );
  return { deliverySucceeded };
}

function deliverySuffix(entry, lane) {
  if (typeof entry.deliverySucceeded !== 'boolean') return '';
  return `; ${lane.deliveryJobName} ${entry.deliverySucceeded ? 'succeeded' : 'did not succeed'}`;
}

// The Discord line under a stopped run on a lane with a delivery job.
function deliveryGuidance(entry, lane) {
  if (typeof entry.deliverySucceeded !== 'boolean') return null;
  return entry.deliverySucceeded
    ? `  \`${lane.deliveryJobName}\` had already succeeded; only the jobs after it were lost.`
    : `  \`${lane.deliveryJobName}\` did not succeed. A native republish or the release/next tip is re-dispatched below; any other run is not retried: dispatch ${lane.workflowFile} again for this branch unless a later run there publishes the same platforms.`;
}

function shortSha(run) {
  return typeof run?.head_sha === 'string' ? run.head_sha.slice(0, 7) : 'unknown';
}

// A lane that spans branches names the branch, and the run title: on the OTA
// lane that is what tells a train push from a "Republish ios after native
// build" dispatch, whose publish nothing else re-sends. Titles come from the
// workflow's run-name; backticks and newlines are stripped so one cannot break
// the Discord formatting.
const RUN_TITLE_LIMIT = 80;

function runContext(run, lane) {
  if (lane.branch !== null) return '';
  const branch = String(run?.head_branch ?? 'unknown branch');
  const title = String(run?.display_title ?? '')
    .replace(/[\r\n`]/g, ' ')
    .trim()
    .slice(0, RUN_TITLE_LIMIT);
  return title === '' ? ` on ${branch}` : ` on ${branch}, "${title}"`;
}

function describeRun(entry, lane = PRODUCTION_DEPLOY_LANE) {
  const { run, reason } = entry;
  return `run #${run.run_number ?? run.id} (${shortSha(run)}${runContext(run, lane)}, status=${run.status}): ${reason}${deliverySuffix(entry, lane)}`;
}

function formatSummary(
  plan,
  {
    dryRun = false,
    failedCancelIds = new Set(),
    dispatched = plan.redispatch,
    lane = PRODUCTION_DEPLOY_LANE,
    unreadableRuns = [],
  } = {},
) {
  const verb = dryRun ? 'would cancel' : 'stopped';
  const lines = [];
  for (const run of unreadableRuns) {
    lines.push(
      `could NOT read the job list of ${describeRun({ run, reason: 'it holds the lane, and this lane has no age ceiling to fall back on. Not cancelled; check the run by hand' }, lane)}`,
    );
  }
  for (const entry of plan.cancel) {
    const failed = failedCancelIds.has(String(entry.run.id));
    lines.push(`${failed ? 'could NOT cancel' : verb} ${describeRun(entry, lane)}`);
  }
  for (const entry of plan.alert) lines.push(`alerting on ${describeRun(entry, lane)}`);
  if (dispatched) {
    lines.push(
      dryRun ? 'would dispatch a fresh production deploy for main' : 'dispatched a fresh production deploy for main',
    );
  }
  if (plan.followUp === 'needs-intervention') {
    lines.push('main is NOT deploying: nothing is queued and this head sha has no retry left — needs a human');
  }
  if (lines.length === 0) lines.push(lane.copy.quiet);
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

// Discord content. Mirrors the deploy notifications in production-deploy.yml:
// URLs wrapped in <…> so Discord drops the inline preview embed.
function formatDiscordContent(
  plan,
  { runUrlBase = '', failedCancelIds = new Set(), followUp = plan.followUp, lane = PRODUCTION_DEPLOY_LANE } = {},
) {
  const { copy } = lane;
  if (plan.cancel.length === 0 && plan.alert.length === 0) {
    // Report a recovery attempt without claiming this tick stopped a run.
    // Retry-spent ticks stay quiet rather than notifying every 15 minutes.
    if (plan.recoveringCancelledRun && (followUp === 'redispatched' || followUp === 'dispatch-deferred')) {
      return `${copy.recovery}\n${copy.followUps[followUp]}`;
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
    lines.push(failed.length > 0 ? copy.stillWedged : copy.unwedged);
    for (const entry of cancelled) {
      lines.push(
        `• Stopped run #${entry.run.run_number ?? entry.run.id} (\`${shortSha(entry.run)}\`${runContext(entry.run, lane)}) — ${entry.reason}.`,
      );
      const guidance = deliveryGuidance(entry, lane);
      if (guidance !== null) lines.push(guidance);
      if (runUrlBase !== '') lines.push(`  <${runUrlBase}/${entry.run.id}>`);
    }
    // Reported, not omitted: a cancel that did not land may mean the run is
    // still holding the group, which is the one thing an operator needs to know.
    for (const entry of failed) {
      lines.push(
        `• Could NOT cancel run #${entry.run.run_number ?? entry.run.id} (\`${shortSha(entry.run)}\`${runContext(entry.run, lane)}) — it may still be holding the group. Retrying next tick.`,
      );
      if (runUrlBase !== '') lines.push(`  <${runUrlBase}/${entry.run.id}>`);
    }
    lines.push(copy.followUps[followUp] ?? copy.followUps[copy.unknownFollowUp]);
    lines.push(copy.checkGate);
  }
  for (const entry of plan.alert) {
    lines.push(
      `${copy.stillRunning} — run #${entry.run.run_number ?? entry.run.id} (\`${shortSha(entry.run)}\`${runContext(entry.run, lane)}), ${entry.reason}. Not cancelled.`,
    );
    if (runUrlBase !== '') lines.push(`<${runUrlBase}/${entry.run.id}>`);
  }
  return capDiscordContent(lines.join('\n'));
}

// ─── OTA lane recovery ───────────────────────────────────────────────────────

// mobile-ota-production.yml's run-name for a native build's republish. The run
// list carries no dispatch inputs, so the name is the only record of them. The
// fingerprint must be a full hex hash: it is spliced into a dispatch.
const REPUBLISH_RUN_NAME = /^Republish (ios|android) after native build \(([0-9a-f]{40})\)$/;

function parseRepublishRunName(name) {
  const match = REPUBLISH_RUN_NAME.exec(typeof name === 'string' ? name : '');
  return match === null ? null : { platform: match[1], fingerprint: match[2] };
}

function republishCommand({ ref, platform, fingerprint }) {
  return `gh workflow run mobile-ota-production.yml --ref ${ref} -f platform=${platform} -f expect_fingerprint=${fingerprint}`;
}

// A cancelled run can strand JS two ways, and both are checked on EVERY tick,
// not only right after this pass cancels something. A cancel that lands after
// the tick gave up confirming it (or one an operator made) leaves a completed,
// cancelled run that no later tick would otherwise look at again.
const RECOVERY_WINDOW_MINUTES = 24 * 60;

// A republish can also strand its binary by FAILING: its store evidence was
// resolved before it waited for the lane, and publish refuses evidence past
// TRAIN_LIVE_STORE_MAX_AGE_MS in a step of its own. The name is the marker, and
// mobile-ota-production.yml must keep it; a test pins the two together.
const STALE_EVIDENCE_STEP = 'Refuse stale public store evidence';
// Nobody else reports that failure as stranding, so it is reported (and fails
// this job) on the ticks that first see it, not only when this tick acted.
// Two ticks' worth, so a delayed schedule still catches it.
const FRESH_FAILURE_MINUTES = 30;

function refusedStaleEvidence(jobs, laneJob) {
  return (jobs ?? []).some(
    (job) =>
      job?.name === laneJob &&
      (job.steps ?? []).some((step) => step?.name === STALE_EVIDENCE_STEP && step?.conclusion === 'failure'),
  );
}

const completedWithin = (run, minutes, nowMs) => {
  const age = minutesSince(run?.updated_at ?? run?.created_at, nowMs);
  return age !== null && age <= minutes;
};
const TRAIN_BRANCH = 'release/next';
const TRAIN_DISPATCH_COMMAND = `gh workflow run mobile-ota-production.yml --ref ${TRAIN_BRANCH}`;

const runName = (run) => run?.name ?? run?.display_title;
const withinRecoveryWindow = (run, nowMs) => {
  const age = minutesSince(run?.updated_at ?? run?.created_at, nowMs);
  return age !== null && age <= RECOVERY_WINDOW_MINUTES;
};

// 1. A native build's republish. One retry per republish: a same-named run
//    created later means the retry already exists, and an earlier same-named run
//    that was itself cancelled or failed means this run WAS the retry. Any
//    unreadable input withholds the dispatch and hands the command to a human.
function decideRepublish({ run, laneJob, finalJobs, dispatchedRuns }) {
  const republish = parseRepublishRunName(runName(run));
  if (republish === null) return { action: 'none' };
  const ref = run.head_branch ?? '';
  const decision = {
    kind: 'republish',
    ...republish,
    runId: run.id,
    name: runName(run),
    ref,
    command: republishCommand({ ref: ref || TRAIN_BRANCH, ...republish }),
  };
  if (ref === '') return { ...decision, action: 'unreadable', reason: 'the run has no branch' };
  if (finalJobs === null) return { ...decision, action: 'unreadable', reason: 'its job list could not be read' };
  if (finalJobs.some((job) => job?.name === laneJob && job?.conclusion === 'success')) {
    return { ...decision, action: 'already-published' };
  }
  if (dispatchedRuns === null) {
    return { ...decision, action: 'unreadable', reason: 'the dispatch history could not be read' };
  }
  const sameName = dispatchedRuns.filter(
    (other) => String(other?.id) !== String(run.id) && runName(other) === decision.name,
  );
  if (sameName.some((other) => Number(other.id) > Number(run.id))) return { ...decision, action: 'replacement-exists' };
  if (
    sameName.some(
      (other) =>
        Number(other.id) < Number(run.id) && (other?.conclusion === 'cancelled' || other?.conclusion === 'failure'),
    )
  ) {
    return { ...decision, action: 'retry-spent' };
  }
  return { ...decision, action: 'redispatch' };
}

// 2. The release/next tip. Older train pushes skip as superseded once the tip
//    moves, so if the tip's own run is cancelled, or fails because its store
//    evidence aged out while it waited last in a backlog, nothing publishes it.
//    ("Re-run failed jobs" would reuse the same stale artifact.) A
//    dispatch on the branch re-runs it: dispatches skip the push-only superseded
//    step and still check the tip. Once per tip: any earlier dispatch for the tip
//    (ours or an operator's) spends the retry. Republish runs are left to (1).
function decideTipRecovery({ tip, branchRuns, finalJobs, laneJob, nowMs }) {
  const base = {
    kind: 'tip',
    name: `the ${TRAIN_BRANCH} tip${typeof tip === 'string' ? ` (${tip.slice(0, 7)})` : ''}`,
    ref: TRAIN_BRANCH,
    command: TRAIN_DISPATCH_COMMAND,
  };
  if (tip === null) return { ...base, action: 'unreadable', reason: `the ${TRAIN_BRANCH} head could not be read` };
  if (branchRuns === null) return { ...base, action: 'unreadable', reason: 'the run history could not be read' };
  const tipRuns = branchRuns.filter((run) => run?.head_sha === tip && parseRepublishRunName(runName(run)) === null);
  if (tipRuns.length === 0) return { ...base, action: 'none', reason: 'the tip has no run' };
  if (tipRuns.some((run) => run?.status !== 'completed'))
    return { ...base, action: 'none', reason: 'a tip run is live' };
  if (tipRuns.some((run) => run?.conclusion === 'success')) return { ...base, action: 'none', reason: 'the tip ran' };
  const latest = tipRuns.reduce((newest, run) => (Number(run.id) > Number(newest.id) ? run : newest));
  if (!withinRecoveryWindow(latest, nowMs)) return { ...base, action: 'none', reason: 'the tip run is old' };
  const staleFailure = latest.conclusion === 'failure' && refusedStaleEvidence(finalJobs, laneJob);
  if (latest.conclusion !== 'cancelled' && !staleFailure) {
    return { ...base, action: 'none', reason: 'the tip run was not cancelled or refused stale evidence' };
  }
  const decision = { ...base, runId: latest.id, staleFailure };
  if (finalJobs === null) return { ...decision, action: 'unreadable', reason: 'its job list could not be read' };
  if (finalJobs.some((job) => job?.name === laneJob && job?.conclusion === 'success')) {
    return { ...decision, action: 'already-published' };
  }
  if (tipRuns.some((run) => run?.event === 'workflow_dispatch')) return { ...decision, action: 'retry-spent' };
  return { ...decision, action: 'redispatch' };
}

const RECOVERY_SUMMARY = {
  redispatch: (decision, dryRun) =>
    `${dryRun ? 'would re-dispatch' : 're-dispatched'} ${decision.kind === 'tip' ? decision.name : `"${decision.name}"`} on ${decision.ref}`,
  'dispatch-failed': (decision) => `could NOT re-dispatch ${decision.name} on ${decision.ref}`,
  'already-published': (decision) => `${decision.name} had already published; nothing to re-dispatch`,
  'replacement-exists': (decision) => `${decision.name} already has a newer run; not re-dispatching`,
  'retry-spent': (decision) => `${decision.name} already had its one retry; not re-dispatching`,
  'cancel-unconfirmed': (decision) => `${decision.name} is not confirmed stopped; re-checked next tick`,
  'redispatch-off': (decision) =>
    `OTA_LANE_REDISPATCH is off; not re-dispatching ${decision.name}: ${decision.command}`,
  unreadable: (decision) => `not re-dispatching ${decision.name}: ${decision.reason}`,
};

function recoveryLine({ decision }) {
  const label = decision.kind === 'tip' ? decision.name : `"${decision.name}"`;
  switch (decision.action) {
    case 'redispatch':
      return decision.kind === 'tip'
        ? [`• Dispatched a fresh publish for ${label}; its own run was cancelled and older pushes skip as superseded.`]
        : [`• Re-dispatched ${label} on \`${decision.ref}\` so that binary still gets its update.`];
    case 'already-published':
      return [`• ${label} had already published; nothing was stranded.`];
    case 'replacement-exists':
      return [`• ${label} already has a newer run; not re-dispatched.`];
    case 'cancel-unconfirmed':
      return [`• ${label} is not confirmed stopped. Once it is, the next tick re-dispatches it.`];
    case 'redispatch-off':
      return [
        `⏸️ **${label} needs a re-dispatch**, but OTA_LANE_REDISPATCH is off. Run it when ready:`,
        `\`${decision.command}\``,
      ];
    default: {
      // No @here: the webhook post sets allowed_mentions.parse=[].
      const why =
        decision.action === 'retry-spent'
          ? 'it already had its one retry'
          : decision.action === 'dispatch-failed'
            ? 'the dispatch failed'
            : decision.reason;
      return [`🚨 **${label} was NOT re-dispatched** (${why}). Run it by hand:`, `\`${decision.command}\``];
    }
  }
}

// Decisions on runs this tick did not touch are reported only when they act:
// a spent retry from yesterday must not ping the channel every 15 minutes.
const QUIET_UNLESS_TOUCHED = new Set(['already-published', 'replacement-exists', 'retry-spent', 'unreadable']);
const FAILING_RECOVERIES = new Set(['dispatch-failed', 'unreadable', 'retry-spent']);

// Unset, empty or anything but `off` leaves dispatching on: a typo must not
// silently disable recovery.
function redispatchEnabledFrom(env) {
  return (env.OTA_LANE_REDISPATCH ?? '').trim().toLowerCase() !== 'off';
}

// The OTA lane's recovery pass, run on every tick after the cancels.
// `stoppedRuns` are the runs this tick stopped (in a dry run, would stop) and
// `unconfirmedRuns` the ones whose cancel it could not confirm. Returns
// `{ decision, touched }` entries for the report; decisions about runs this
// tick did not touch are logged, not reported, unless they act.
function recoverStrandedOtaRuns({
  github,
  lane,
  stoppedRuns = [],
  unconfirmedRuns = [],
  // Stopped runs whose publish had already succeeded: nothing to recover.
  deliveredRunIds = new Set(),
  nowMs,
  dryRun = false,
  redispatchEnabled = true,
  logPrefix = `${lane.name}-watchdog:`,
}) {
  const laneJob = lane.deliveryJobName;
  const recoveries = [];
  const touched = new Map(stoppedRuns.map((run) => [String(run.id), run]));

  // The cancel may still land after this tick. The scan on a later tick picks
  // the run up once it has completed.
  for (const run of unconfirmedRuns) {
    const republish = parseRepublishRunName(runName(run));
    if (republish === null) continue;
    const ref = run.head_branch || TRAIN_BRANCH;
    recoveries.push({
      decision: {
        kind: 'republish',
        ...republish,
        runId: run.id,
        name: runName(run),
        ref,
        command: republishCommand({ ref, ...republish }),
        action: 'cancel-unconfirmed',
      },
      touched: true,
    });
  }

  // `isFresh`: the run completed within the last two ticks, or this tick
  // stopped it. With dispatch switched off, only those post the command, so a
  // run stays in the channel for two ticks rather than for a day.
  const decide = (decision, isTouched, isFresh = isTouched) => {
    if (decision.action === 'none') return;
    if (!isTouched && QUIET_UNLESS_TOUCHED.has(decision.action)) {
      console.error(`${logPrefix} ${RECOVERY_SUMMARY[decision.action](decision, dryRun)}`);
      return;
    }
    if (decision.action === 'redispatch' && !redispatchEnabled) {
      const held = { ...decision, action: 'redispatch-off' };
      if (isFresh) recoveries.push({ decision: held, touched: isTouched });
      else console.error(`${logPrefix} ${RECOVERY_SUMMARY['redispatch-off'](held)}`);
      return;
    }
    let settled = decision;
    if (decision.action === 'redispatch' && !dryRun) {
      try {
        if (decision.kind === 'tip') github.dispatchWorkflow(decision.ref, {});
        else
          github.dispatchWorkflow(decision.ref, {
            platform: decision.platform,
            expect_fingerprint: decision.fingerprint,
          });
      } catch (error) {
        console.error(`${logPrefix} dispatch failed: ${error.message}`);
        settled = { ...decision, action: 'dispatch-failed' };
      }
    }
    recoveries.push({ decision: settled, touched: isTouched });
  };

  let dispatchedRuns = null;
  try {
    dispatchedRuns = github.listDispatchedRuns();
  } catch (error) {
    console.error(`${logPrefix} could not read dispatch history: ${error.message}`);
  }
  const republishRuns = new Map(
    [...touched.values()]
      .filter((run) => parseRepublishRunName(runName(run)) !== null)
      .map((run) => [String(run.id), run]),
  );
  // The runs this tick stopped count as history too, in case the listing
  // predates them.
  const knownRuns =
    dispatchedRuns === null
      ? null
      : [
          ...dispatchedRuns,
          ...[...republishRuns.values()].filter(
            (run) => !dispatchedRuns.some((listed) => String(listed?.id) === String(run.id)),
          ),
        ];
  const jobsByRunId = new Map();
  const jobsOf = (run) => {
    if (!jobsByRunId.has(String(run.id))) jobsByRunId.set(String(run.id), github.listJobs(run.id));
    return jobsByRunId.get(String(run.id));
  };
  const freshFailureIds = new Set();
  for (const run of knownRuns ?? []) {
    const isRecent =
      run?.status === 'completed' &&
      parseRepublishRunName(runName(run)) !== null &&
      withinRecoveryWindow(run, nowMs) &&
      !knownRuns.some((other) => runName(other) === runName(run) && Number(other.id) > Number(run.id));
    if (!isRecent || republishRuns.has(String(run.id))) continue;
    if (run.conclusion === 'cancelled') republishRuns.set(String(run.id), run);
    if (run.conclusion !== 'failure') continue;
    // Only an age refusal: any other failure is the run's own to report.
    if (!refusedStaleEvidence(jobsOf(run), laneJob)) continue;
    republishRuns.set(String(run.id), run);
    if (completedWithin(run, FRESH_FAILURE_MINUTES, nowMs)) freshFailureIds.add(String(run.id));
  }
  for (const run of republishRuns.values()) {
    decide(
      decideRepublish({ run, laneJob, finalJobs: jobsOf(run), dispatchedRuns: knownRuns }),
      touched.has(String(run.id)) || freshFailureIds.has(String(run.id)),
      touched.has(String(run.id)) || completedWithin(run, FRESH_FAILURE_MINUTES, nowMs),
    );
  }

  let tip = null;
  let branchRuns = null;
  try {
    tip = github.getBranchHead(TRAIN_BRANCH);
    branchRuns = github.listBranchRuns(TRAIN_BRANCH);
  } catch (error) {
    console.error(`${logPrefix} could not read the ${TRAIN_BRANCH} tip or its runs: ${error.message}`);
  }
  const tipRuns = (branchRuns ?? []).filter(
    (run) => run?.head_sha === tip && parseRepublishRunName(runName(run)) === null,
  );
  const latestTipRun = tipRuns.reduce(
    (newest, run) => (newest === null || Number(run.id) > Number(newest.id) ? run : newest),
    null,
  );
  const tipDecision = decideTipRecovery({
    tip,
    branchRuns,
    // Only a cancelled or failed latest tip run needs its jobs read.
    finalJobs: ['cancelled', 'failure'].includes(latestTipRun?.conclusion) ? github.listJobs(latestTipRun.id) : [],
    laneJob,
    nowMs,
  });
  // A tip run this tick stopped is the one case worth a ping even when the
  // tip cannot be read: the push may never publish otherwise. A fresh
  // stale-evidence failure is too, as for republishes.
  const tipTouched = [...touched.values()].some(
    (run) =>
      run.event === 'push' &&
      run.head_branch === TRAIN_BRANCH &&
      !deliveredRunIds.has(String(run.id)) &&
      (tip === null || run.head_sha === tip),
  );
  const tipFresh = latestTipRun !== null && completedWithin(latestTipRun, FRESH_FAILURE_MINUTES, nowMs);
  decide(tipDecision, tipTouched || (tipDecision.staleFailure === true && tipFresh), tipTouched || tipFresh);
  return recoveries;
}

function recoveryFailed(recoveries) {
  return recoveries.some(
    ({ decision, touched: isTouched }) =>
      decision.action === 'dispatch-failed' || (isTouched && FAILING_RECOVERIES.has(decision.action)),
  );
}

// Appends the recovery lines to a lane report: under the stopped runs when
// there are any, else under a recovery headline of their own.
function withRecoveryLines(content, recoveries, lane) {
  if (recoveries.length === 0) return content;
  const recoveryLines = recoveries.flatMap((recovery) => recoveryLine(recovery));
  const head = content === '' ? lane.copy.recovery : content;
  return capDiscordContent([head, ...recoveryLines].join('\n'));
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

// `branch: null` lists every branch (the OTA lane); the default keeps the
// production-deploy listing on main.
function createCliGitHub({ repository, workflowFile, branch = 'main', api, now = Date.now }) {
  const branchQuery = branch === null ? '' : `branch=${encodeURIComponent(branch)}&`;
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
        `repos/${repository}/actions/workflows/${workflowFile}/runs?${branchQuery}status=${status}&per_page=${RUNS_PAGE_SIZE}`,
      ]);
      const parsed = JSON.parse(payload);
      if (!Array.isArray(parsed?.workflow_runs)) throw new Error('unreadable workflow history');
      return parsed.workflow_runs;
    },
    listRecentRuns() {
      const payload = ghApi([
        '--method',
        'GET',
        `repos/${repository}/actions/workflows/${workflowFile}/runs?${branchQuery}per_page=${RUNS_PAGE_SIZE}`,
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
    // OTA recovery reads. Filtered by event so a backlog of push runs cannot
    // page a republish out.
    listDispatchedRuns() {
      const parsed = JSON.parse(
        ghApi([
          '--method',
          'GET',
          `repos/${repository}/actions/workflows/${workflowFile}/runs?${branchQuery}event=workflow_dispatch&per_page=${RUNS_PAGE_SIZE}`,
        ]),
      );
      if (!Array.isArray(parsed?.workflow_runs)) throw new Error('unreadable workflow history');
      return parsed.workflow_runs;
    },
    // One branch's recent runs, whatever this adapter's own branch filter is.
    listBranchRuns(branchName) {
      const parsed = JSON.parse(
        ghApi([
          '--method',
          'GET',
          `repos/${repository}/actions/workflows/${workflowFile}/runs?branch=${encodeURIComponent(branchName)}&per_page=${RUNS_PAGE_SIZE}`,
        ]),
      );
      if (!Array.isArray(parsed?.workflow_runs)) throw new Error('unreadable workflow history');
      return parsed.workflow_runs;
    },
    getBranchHead(branchName) {
      const reference = JSON.parse(ghApi(['--method', 'GET', `repos/${repository}/git/ref/heads/${branchName}`]));
      if (typeof reference?.object?.sha !== 'string' || !/^[0-9a-f]{40}$/.test(reference.object.sha)) {
        throw new Error(`unreadable ${branchName} head`);
      }
      return reference.object.sha;
    },
    dispatchWorkflow(ref, inputs) {
      ghApi([
        '--method',
        'POST',
        `repos/${repository}/actions/workflows/${workflowFile}/dispatches`,
        '-f',
        `ref=${ref}`,
        ...Object.entries(inputs).flatMap(([name, inputValue]) => ['-f', `inputs[${name}]=${inputValue}`]),
      ]);
    },
  };
}

// Every listed job has finished, and the newest finished SETTLED_QUIET_MS ago.
// An empty or unreadable list is never settled: it proves nothing about what
// is running.
function isSettled(jobs, nowMs) {
  if (!Array.isArray(jobs) || jobs.length === 0) return false;
  if (!jobs.every((job) => job?.status === 'completed')) return false;
  const completedTimes = jobs.map((job) => Date.parse(job?.completed_at ?? ''));
  if (!completedTimes.every(Number.isFinite)) return false;
  return nowMs - Math.max(...completedTimes) >= SETTLED_QUIET_MS;
}

// Both stages require observed completion: a 202 response only acknowledges
// the request. Recheck eligibility before force-cancelling an idle intervention,
// under the SAME lane rules that picked the target: re-checking an OTA run
// against production-deploy's six-hour ceiling would force-cancel a publish
// that resumed meanwhile.
async function cancelAndConfirm({
  github,
  runId,
  now = Date.now,
  sleep = sleepTimer,
  deadlineMs,
  rules = laneRules(PRODUCTION_DEPLOY_LANE),
}) {
  const requireTime = () => {
    if (now() >= deadlineMs) throw new Error('watchdog deadline exceeded');
  };
  requireTime();
  let run = github.getRun(runId);
  if (run.status === 'completed') return 'stopped';
  const jobs = github.listJobs(runId);
  if (classifyRun({ run, jobs, nowMs: now(), ...rules }).action !== 'cancel') {
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
  // Our cancel took the parked job down but the run never reached `completed`.
  // classifyRun reads that as "not parked", and on a lane with no age ceiling
  // nothing would ever end it. Only lanes that opt in (see
  // forceSettledRunAfterCancel) force it.
  const settledAfterCancel = rules.forceSettledRunAfterCancel === true && isSettled(freshJobs, now());
  if (!settledAfterCancel && classifyRun({ run, jobs: freshJobs, nowMs: now(), ...rules }).action !== 'cancel') {
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
  lane = PRODUCTION_DEPLOY_LANE,
  headSha,
  nowMs,
  now = Date.now,
  sleep = sleepTimer,
  runUrlBase,
  discordFilePath,
  outputPath,
  dryRun,
  // OTA_LANE_REDISPATCH=off: the OTA recovery posts commands instead of dispatching.
  redispatchEnabled = true,
}) {
  const logPrefix = `${lane.name}-watchdog:`;
  const rules = laneRules(lane);
  const deadlineMs = now() + WATCHDOG_BUDGET_MS;
  github.setDeadline?.(deadlineMs);
  const { runs, recentPageOk } = github.listRuns();
  const jobsByRunId = {};
  for (const run of runs) {
    if (isHoldingRun(run)) jobsByRunId[String(run.id)] = github.listJobs(run.id);
  }
  const plannedActions = planWatchdogActions({ runs, jobsByRunId, headSha, nowMs: nowMs ?? now(), lane });
  // production-deploy's six-hour ceiling still applies to a run whose jobs it
  // cannot read. A lane with no age limit has no such backstop: without the job
  // list it can neither cancel nor clear the run, so it must not report "all
  // clear". The run is named and the watchdog job goes red; nothing is cancelled.
  const unreadableRuns = Number.isFinite(lane.maxRunMinutes)
    ? []
    : runs.filter((run) => isHoldingRun(run) && jobsByRunId[String(run.id)] === null);
  const failedCancelIds = new Set();
  const resumedIds = new Set();
  const hadCandidates = plannedActions.cancel.length > 0;
  for (const entry of plannedActions.cancel) {
    console.error(`${logPrefix} ${dryRun ? 'would cancel' : 'cancelling'} ${describeRun(entry, lane)}`);
    if (dryRun) continue;
    try {
      const result = await cancelAndConfirm({ github, runId: entry.run.id, now, sleep, deadlineMs, rules });
      if (result === 'resumed') {
        resumedIds.add(String(entry.run.id));
        console.error(`${logPrefix} run ${entry.run.id} resumed; cancellation escalation withheld`);
      }
    } catch (error) {
      failedCancelIds.add(String(entry.run.id));
      console.error(`${logPrefix} could NOT stop ${describeRun(entry, lane)}: ${error.message}`);
    }
  }
  const plan = {
    ...plannedActions,
    cancel: plannedActions.cancel.filter((entry) => !resumedIds.has(String(entry.run.id))),
  };
  // A target that resumed was not stopped, so there is no queue to hand over to.
  if (!lane.redispatch) plan.followUp = plan.cancel.length > 0 ? 'queue-resumes' : 'none';

  let historyOk = recentPageOk;
  // Everything from here to the dispatch is production-deploy's recovery: the
  // OTA lane has nothing to refresh, because nothing it decides depends on it.
  if (lane.redispatch && (hadCandidates || plan.recoveringCancelledRun)) {
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
      console.error(`${logPrefix} could not refresh run history: ${error.message}`);
    }
  }
  let dispatched = false;
  let dispatchFailed = false;
  if (lane.redispatch && plan.redispatch && failedCancelIds.size === 0 && historyOk) {
    try {
      if (!dryRun) github.dispatchRun('main');
      dispatched = true;
    } catch (error) {
      dispatchFailed = true;
      console.error(`${logPrefix} dispatch failed: ${error.message}`);
    }
  }
  if (failedCancelIds.size > 0) plan.followUp = 'cancel-failed';
  else if (lane.redispatch && (!historyOk || dispatchFailed)) plan.followUp = 'dispatch-deferred';

  const recoveries = lane.recovery
    ? recoverStrandedOtaRuns({
        github,
        lane,
        stoppedRuns: plan.cancel
          .filter((entry) => !failedCancelIds.has(String(entry.run.id)))
          .map((entry) => entry.run),
        unconfirmedRuns: plan.cancel
          .filter((entry) => failedCancelIds.has(String(entry.run.id)))
          .map((entry) => entry.run),
        deliveredRunIds: new Set(
          plan.cancel.filter((entry) => entry.deliverySucceeded === true).map((entry) => String(entry.run.id)),
        ),
        nowMs: nowMs ?? now(),
        dryRun,
        redispatchEnabled,
        logPrefix,
      })
    : [];

  const baseSummary = formatSummary(plan, { dryRun, failedCancelIds, dispatched, lane, unreadableRuns });
  const recoverySummary = recoveries.map(({ decision }) => RECOVERY_SUMMARY[decision.action](decision, dryRun));
  const summary =
    recoverySummary.length === 0
      ? baseSummary
      : [...(baseSummary === lane.copy.quiet ? [] : [baseSummary]), ...recoverySummary].join('\n');
  console.error(`${logPrefix} ${summary}`);
  const discordContent = dryRun
    ? ''
    : withRecoveryLines(formatDiscordContent(plan, { runUrlBase, failedCancelIds, lane }), recoveries, lane);
  if (discordContent !== '' && discordFilePath) writeFileSync(discordFilePath, discordContent, 'utf8');
  if (outputPath) appendFileSync(outputPath, `notify=${discordContent === '' ? 'false' : 'true'}\n`, 'utf8');
  // An incomplete run listing fails both lanes, and an unreadable holder fails a
  // lane with no age ceiling: a watchdog that cannot see the lane must go red
  // rather than report "all clear".
  return {
    ...plan,
    unreadableRuns,
    recoveries,
    failed:
      !dryRun &&
      (failedCancelIds.size > 0 ||
        !historyOk ||
        dispatchFailed ||
        unreadableRuns.length > 0 ||
        recoveryFailed(recoveries)),
  };
}

function resolveLane(laneName) {
  const lane = Object.hasOwn(LANES, laneName) ? LANES[laneName] : undefined;
  if (lane === undefined) {
    throw new Error(`unknown --lane "${laneName}"; expected one of: ${Object.keys(LANES).join(', ')}`);
  }
  return lane;
}

function parseCliArguments(argv) {
  const options = {
    repository: process.env.GITHUB_REPOSITORY ?? '',
    lane: PRODUCTION_DEPLOY_LANE,
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
      case '--lane':
        options.lane = resolveLane(optionValue ?? '');
        argumentIndex += 1;
        break;
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
      redispatchEnabled: redispatchEnabledFrom(process.env),
      github: createCliGitHub({
        repository: options.repository,
        workflowFile: options.lane.workflowFile,
        branch: options.lane.branch,
      }),
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
  LANES,
  MOBILE_OTA_LANE,
  PRODUCTION_DEPLOY_LANE,
  STALE_EVIDENCE_STEP,
  cancelAndConfirm,
  classifyRun,
  createCliGitHub,
  decideRepublish,
  decideTipRecovery,
  formatDiscordContent,
  formatDuration,
  formatSummary,
  isHoldingRun,
  isParked,
  laneRules,
  parseCliArguments,
  parseRepublishRunName,
  planWatchdogActions,
  recoverStrandedOtaRuns,
  redispatchEnabledFrom,
  runCli,
};
