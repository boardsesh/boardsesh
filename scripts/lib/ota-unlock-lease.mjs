/** Observed caller lifetime, checked immediately before protected unlock writes. */
export const MAX_UNLOCK_LEASE_MS = 20 * 60_000;
export const UNLOCK_WRITE_HEADROOM_MS = 30_000;
const MAX_JOB_PAGES = 100;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const RULES = {
  '.github/workflows/mobile-ota-production.yml': {
    jobKey: 'publish',
    jobNames: ['publish'],
    branches: ['main', 'release/next'],
    stepName: 'Await trusted main unlock before direct production publish',
  },
  '.github/workflows/mobile-ota-promote-staged.yml': {
    jobKey: 'promote',
    jobNames: ['promote'],
    branches: ['main'],
    stepName: 'Await trusted main-only production unlock',
  },
  '.github/workflows/mobile-ota-backport.yml': {
    jobKey: 'backport',
    jobNames: ['backport (ios)', 'backport (android)'],
    branches: ['main'],
    stepName: 'Await trusted main unlock before the backport publish',
  },
};

function record(input, label) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error(`Invalid ${label}.`);
  return input;
}
function positiveInteger(input, label) {
  if (!Number.isSafeInteger(input) || input < 1) throw new Error(`Invalid ${label}.`);
  return input;
}
function callerRule(caller) {
  const rule = RULES[caller.workflowPath];
  if (!rule || rule.jobKey !== caller.jobKey || !rule.branches.includes(caller.headBranch))
    throw new Error('Unlock caller workflow, branch or job is not permitted.');
  return rule;
}
function validateCaller(caller) {
  record(caller, 'unlock caller');
  positiveInteger(caller.runId, 'caller run ID');
  positiveInteger(caller.runAttempt, 'caller run attempt');
  if (!SHA.test(caller.headSha) || typeof caller.runnerName !== 'string' || !caller.runnerName.trim())
    throw new Error('Invalid caller head SHA or runner name.');
  return callerRule(caller);
}

export function unlockCallerFromEnvironment(environment, repository) {
  const prefix = `${repository}/`;
  const workflowRef = environment.GITHUB_WORKFLOW_REF ?? '';
  const separator = workflowRef.indexOf('@refs/heads/');
  if (!workflowRef.startsWith(prefix) || separator < prefix.length)
    throw new Error('Unlock caller requires a same-repository branch workflow ref.');
  const caller = {
    workflowPath: workflowRef.slice(prefix.length, separator),
    headBranch: workflowRef.slice(separator + '@refs/heads/'.length),
    runId: Number(environment.GITHUB_RUN_ID),
    runAttempt: Number(environment.GITHUB_RUN_ATTEMPT),
    headSha: environment.GITHUB_SHA,
    jobKey: environment.GITHUB_JOB,
    runnerName: environment.RUNNER_NAME,
  };
  validateCaller(caller);
  return caller;
}

function validateLease(input, repository, requestId) {
  const lease = record(input, 'unlock caller lease');
  const rule = validateCaller(lease);
  if (
    lease.version !== 1 ||
    lease.repository !== repository ||
    lease.requestId !== requestId ||
    !REQUEST_ID.test(requestId) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !Number.isSafeInteger(lease.issuedAtMs) ||
    lease.issuedAtMs < 0 ||
    !Number.isSafeInteger(lease.expiresAtMs) ||
    lease.expiresAtMs <= lease.issuedAtMs ||
    lease.expiresAtMs - lease.issuedAtMs > MAX_UNLOCK_LEASE_MS ||
    lease.stepName !== rule.stepName
  )
    throw new Error('Unlock caller lease does not match this bounded request.');
  if (
    typeof lease.branch !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(lease.branch) ||
    !lease.runtimes ||
    ![lease.runtimes.ios, lease.runtimes.android].some(Boolean) ||
    [lease.runtimes.ios, lease.runtimes.android].some(
      (runtime) => typeof runtime !== 'string' || (runtime !== '' && !SHA.test(runtime)),
    )
  )
    throw new Error('Invalid leased unlock branch or runtimes.');
  positiveInteger(lease.jobId, 'caller job ID');
  positiveInteger(lease.stepNumber, 'caller wait-step number');
  return lease;
}
function requireTime(lease, now, headroomMs = 0) {
  const current = now();
  if (!Number.isFinite(current) || lease.issuedAtMs > current + 5_000 || current + headroomMs >= lease.expiresAtMs)
    throw new Error('Unlock caller lease expired or has insufficient write headroom.');
}
function requireRun(runInput, caller, repository) {
  const run = record(runInput, 'caller workflow run');
  if (
    run.id !== caller.runId ||
    run.run_attempt !== caller.runAttempt ||
    run.head_sha !== caller.headSha ||
    run.head_branch !== caller.headBranch ||
    run.path !== caller.workflowPath ||
    run.repository?.full_name !== repository ||
    run.head_repository?.full_name !== repository ||
    !['push', 'workflow_dispatch'].includes(run.event) ||
    run.status !== 'in_progress' ||
    run.conclusion !== null
  )
    throw new Error('Unlock caller run is no longer the expected active workflow attempt.');
}
function matchingWaitStep(jobInput, caller, repository, exactLease) {
  const job = record(jobInput, 'caller job');
  const rule = callerRule(caller);
  if (
    job.run_id !== caller.runId ||
    job.run_attempt !== caller.runAttempt ||
    job.head_sha !== caller.headSha ||
    job.run_url !== `https://api.github.com/repos/${repository}/actions/runs/${caller.runId}` ||
    job.runner_name !== caller.runnerName ||
    !rule.jobNames.includes(job.name) ||
    job.status !== 'in_progress' ||
    job.conclusion !== null ||
    !Array.isArray(job.steps)
  )
    return null;
  positiveInteger(job.id, 'caller job ID');
  const waiting = job.steps.filter((step) => step.name === rule.stepName);
  const active = job.steps.filter((step) => step.status === 'in_progress');
  if (
    waiting.length !== 1 ||
    active.length !== 1 ||
    active[0] !== waiting[0] ||
    waiting[0].conclusion !== null ||
    (exactLease && (job.id !== exactLease.jobId || waiting[0].number !== exactLease.stepNumber))
  )
    return null;
  positiveInteger(waiting[0].number, 'caller wait-step number');
  return waiting[0];
}

/** No dispatch until the complete attempt listing identifies one current waiter. */
export async function discoverUnlockCallerLease(options, dependencies) {
  const { caller, repository, requestId, issuedAtMs, expiresAtMs, branch, iosRuntime, androidRuntime } = options;
  const rule = validateCaller(caller);
  const { api, now, sleep } = dependencies;
  const base = {
    ...caller,
    version: 1,
    repository,
    requestId,
    issuedAtMs,
    expiresAtMs,
    stepName: rule.stepName,
    branch,
    runtimes: { ios: iosRuntime, android: androidRuntime },
  };
  for (let discoveryAttempt = 0; discoveryAttempt < 3; discoveryAttempt++) {
    requireTime(base, now);
    requireRun(await api(`/actions/runs/${caller.runId}`), caller, repository);
    const jobs = [];
    const jobIds = new Set();
    let total;
    for (let page = 1; page <= MAX_JOB_PAGES; page++) {
      const listing = record(
        await api(`/actions/runs/${caller.runId}/attempts/${caller.runAttempt}/jobs?per_page=100&page=${page}`),
        'caller jobs listing',
      );
      if (
        !Array.isArray(listing.jobs) ||
        listing.jobs.length > 100 ||
        !Number.isSafeInteger(listing.total_count) ||
        listing.total_count < 0 ||
        (total !== undefined && total !== listing.total_count)
      )
        throw new Error('Unlock caller jobs listing is incomplete or changed.');
      total = listing.total_count;
      for (const input of listing.jobs) {
        const job = record(input, 'caller job listing entry');
        positiveInteger(job.id, 'caller job ID');
        if (
          jobIds.has(job.id) ||
          job.run_id !== caller.runId ||
          job.run_attempt !== caller.runAttempt ||
          job.head_sha !== caller.headSha
        )
          throw new Error('Unlock caller job listing identity is ambiguous.');
        jobIds.add(job.id);
        jobs.push(job);
      }
      if (jobs.length === total) break;
      if (jobs.length > total || listing.jobs.length !== 100 || page === MAX_JOB_PAGES)
        throw new Error('Unlock caller jobs listing is incomplete.');
    }
    const matches = jobs.flatMap((job) => {
      const step = matchingWaitStep(job, caller, repository);
      return step ? [{ job, step }] : [];
    });
    if (matches.length > 1) throw new Error('Multiple active jobs matched the unlock caller.');
    if (matches.length === 1) {
      requireTime(base, now);
      return validateLease(
        { ...base, jobId: matches[0].job.id, stepNumber: matches[0].step.number },
        repository,
        requestId,
      );
    }
    if (discoveryAttempt < 2) await sleep(1_000 * (discoveryAttempt + 1));
  }
  throw new Error('The exact caller unlock wait step is not visible or active.');
}

/** Automatic requests cannot fall back to manual authorization. */
export function createUnlockLeaseGuard(options, dependencies = {}) {
  const requestId = options.requestId ?? '';
  const serialized = options.serializedLease ?? '';
  if (!requestId && !serialized) return async () => {};
  if (!requestId || !serialized || serialized.length > 8_192)
    throw new Error('Automatic unlock requires its bounded caller lease.');
  const lease = validateLease(JSON.parse(serialized), options.repository, requestId);
  if (
    lease.branch !== options.branch ||
    lease.runtimes.ios !== options.iosRuntime ||
    lease.runtimes.android !== options.androidRuntime
  )
    throw new Error('Unlock caller lease does not match the requested branch and runtimes.');
  if (typeof options.token !== 'string' || !options.token.trim())
    throw new Error('Caller lease requires actions:read.');
  const now = dependencies.now ?? Date.now;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const apiBase = `https://api.github.com/repos/${lease.repository}`;
  return async (target) => {
    if (
      target &&
      (!target.runtimeVersion ||
        target.branch !== lease.branch ||
        !Object.values(lease.runtimes).includes(target.runtimeVersion))
    )
      throw new Error('Unlock write is outside the leased branch and runtimes.');
    async function api(path) {
      requireTime(lease, now, UNLOCK_WRITE_HEADROOM_MS);
      const response = await fetchImpl(`${apiBase}${path}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${options.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(Math.min(30_000, lease.expiresAtMs - now() - UNLOCK_WRITE_HEADROOM_MS)),
        redirect: 'error',
      });
      if (!response.ok) throw new Error('Could not verify the unlock caller lifetime.');
      return response.json();
    }
    requireTime(lease, now, UNLOCK_WRITE_HEADROOM_MS);
    requireRun(await api(`/actions/runs/${lease.runId}`), lease, lease.repository);
    const job = await api(`/actions/jobs/${lease.jobId}`);
    if (!matchingWaitStep(job, lease, lease.repository, lease))
      throw new Error('The unlock caller job or exact wait step is no longer active.');
    // Actions reads can themselves consume the remaining caller lifetime.
    requireTime(lease, now, UNLOCK_WRITE_HEADROOM_MS);
  };
}

/** Keep the selected compare-and-swap ID unchanged across the lifetime check. */
export function protectUnlockWrites(client, guard) {
  return {
    ...client,
    async revertUpdateRollout(...arguments_) {
      await guard({ branch: arguments_[0], runtimeVersion: arguments_[1] });
      return client.revertUpdateRollout(...arguments_);
    },
  };
}
