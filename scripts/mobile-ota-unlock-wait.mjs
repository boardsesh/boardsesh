#!/usr/bin/env node
// Publishers retain the production lane while a main-only workflow reverts the
// matching live canary. The unlock itself must never acquire that same lane.
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const UNLOCK_WORKFLOW_PATH = '.github/workflows/mobile-ota-unlock.yml';
export const UNLOCK_WAIT_MS = 20 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 10_000;
const MAX_READ_FAILURES = 5;
const FINGERPRINT = /^[0-9a-f]{40}$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function unlockRunTitle(requestId) {
  if (typeof requestId !== 'string' || requestId.length !== 36 || !REQUEST_ID.test(requestId))
    throw new Error('Invalid unlock request id.');
  return `OTA unlock ${requestId}`;
}

export function validateUnlockInputs({
  repository,
  token,
  branch = 'production',
  iosRuntime = '',
  androidRuntime = '',
}) {
  if (
    typeof repository !== 'string' ||
    repository !== repository.trim() ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    repository.split('/').some((segment) => segment === '.' || segment === '..')
  )
    throw new Error('Invalid GITHUB_REPOSITORY.');
  if (typeof token !== 'string' || token.trim() === '') throw new Error('GITHUB_TOKEN is required.');
  if (typeof branch !== 'string' || branch !== branch.trim() || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(branch))
    throw new Error('Invalid OTA branch.');
  if (!iosRuntime && !androidRuntime) throw new Error('At least one runtime version is required to unlock.');
  for (const runtime of [iosRuntime, androidRuntime]) {
    if (runtime && (typeof runtime !== 'string' || runtime.length !== 40 || !FINGERPRINT.test(runtime)))
      throw new Error('Runtime versions must be full lowercase fingerprints.');
  }
}

export function validateUnlockRun(run, { repository, workflowId, requestId, expectedRunId, expectedHeadSha }) {
  if (
    !Number.isSafeInteger(run?.id) ||
    run.id < 1 ||
    run.workflow_id !== workflowId ||
    run.path !== UNLOCK_WORKFLOW_PATH ||
    run.event !== 'workflow_dispatch' ||
    run.head_branch !== 'main' ||
    run.repository?.full_name !== repository ||
    run.head_repository?.full_name !== repository ||
    run.display_title !== unlockRunTitle(requestId) ||
    typeof run.head_sha !== 'string' ||
    run.head_sha.length !== 40 ||
    !FINGERPRINT.test(run.head_sha) ||
    run.run_attempt !== 1 ||
    typeof run.status !== 'string' ||
    (expectedRunId !== undefined && run.id !== expectedRunId) ||
    (expectedHeadSha !== undefined && run.head_sha !== expectedHeadSha)
  )
    throw new Error('Unlock run does not match this trusted main dispatch.');
  if (run.status === 'completed' && run.conclusion !== 'success') {
    throw new Error(`Unlock run ${run.id} did not succeed (${String(run.conclusion)}).`);
  }
  return run;
}

export function requireUnlockJobSuccess(jobs, runId) {
  if (!Array.isArray(jobs)) throw new Error('GitHub returned no unlock jobs array.');
  const matchingJobs = jobs.filter((job) => job.name === 'revert');
  if (matchingJobs.length !== 1) throw new Error('Unlock must have exactly one revert job.');
  const job = matchingJobs[0];
  const revertSteps = job.steps?.filter((step) => step.name === 'Revert the live rollouts');
  if (
    job.run_id !== runId ||
    job.run_attempt !== 1 ||
    job.status !== 'completed' ||
    job.conclusion !== 'success' ||
    !Array.isArray(revertSteps) ||
    revertSteps.length !== 1 ||
    revertSteps[0].status !== 'completed' ||
    revertSteps[0].conclusion !== 'success'
  )
    throw new Error('Unlock revert job or revert step did not succeed; refusing to publish.');
}

/** One dispatch, then bounded reads of only its unique request/run. No publish here. */
export async function dispatchAndWaitForUnlock(options, dependencies = {}) {
  validateUnlockInputs(options);
  const { repository, token, branch = 'production', iosRuntime = '', androidRuntime = '' } = options;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const now = dependencies.now ?? Date.now;
  const sleep =
    dependencies.sleep ?? ((milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)));
  const log = dependencies.log ?? console.log;
  const waitBudgetMs = dependencies.waitBudgetMs ?? UNLOCK_WAIT_MS;
  const requestTimeoutMs = dependencies.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const requestId = dependencies.requestId ?? randomUUID();
  const title = unlockRunTitle(requestId);
  const deadline = now() + waitBudgetMs;
  const apiBase = `https://api.github.com/repos/${repository}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };

  async function api(path, method = 'GET', body) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error('Timed out waiting for the main-only OTA unlock.');
    const controller = new AbortController();
    let timeout;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetchImpl(`${apiBase}${path}`, {
            method,
            headers,
            redirect: 'error',
            signal: controller.signal,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          if (!response.ok) throw new Error(`GitHub unlock API failed (${response.status}).`);
          return response.status === 204 ? null : await response.json();
        })(),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => {
              controller.abort();
              reject(new Error('GitHub unlock API request timed out.'));
            },
            Math.min(requestTimeoutMs, remaining),
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  const workflow = await api('/actions/workflows/mobile-ota-unlock.yml');
  if (
    !Number.isSafeInteger(workflow?.id) ||
    workflow.id < 1 ||
    workflow.path !== UNLOCK_WORKFLOW_PATH ||
    workflow.state !== 'active'
  )
    throw new Error('The trusted OTA unlock workflow is unavailable.');
  // Never retry this POST: a timeout can mean GitHub accepted it. A caller must
  // fail closed rather than dispatch an ambiguous second revert.
  await api(`/actions/workflows/${workflow.id}/dispatches`, 'POST', {
    ref: 'main',
    inputs: {
      branch,
      ios_runtime_version: iosRuntime,
      android_runtime_version: androidRuntime,
      request_id: requestId,
    },
  });
  log(`Waiting for ${title} on main before publishing to ${branch}.`);
  let selectedRun;
  let readFailures = 0;
  for (;;) {
    if (now() >= deadline)
      throw new Error('Timed out waiting for the main-only OTA unlock; no publish was authorized.');
    let payload;
    try {
      payload = await api(
        selectedRun
          ? `/actions/runs/${selectedRun.id}`
          : `/actions/workflows/${workflow.id}/runs?branch=main&event=workflow_dispatch&per_page=100`,
      );
      readFailures = 0;
    } catch (error) {
      readFailures += 1;
      if (readFailures >= MAX_READ_FAILURES || now() >= deadline) throw error;
      log('GitHub unlock status is temporarily unreadable; retrying without publishing.');
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - now())));
      continue;
    }
    let run;
    if (selectedRun) {
      run = payload;
    } else {
      if (!Array.isArray(payload?.workflow_runs)) throw new Error('GitHub returned no unlock runs array.');
      const matches = payload.workflow_runs.filter((candidate) => candidate.display_title === title);
      if (matches.length > 1) throw new Error('Multiple runs matched one unlock request; refusing to publish.');
      run = matches[0];
    }
    if (run) {
      validateUnlockRun(run, {
        repository,
        workflowId: workflow.id,
        requestId,
        ...(selectedRun ? { expectedRunId: selectedRun.id, expectedHeadSha: selectedRun.head_sha } : {}),
      });
      selectedRun ??= run;
      if (run.status === 'completed') {
        const result = await api(`/actions/runs/${run.id}/attempts/1/jobs?per_page=100`);
        requireUnlockJobSuccess(result?.jobs, run.id);
        log(`Main-only OTA unlock succeeded: ${run.html_url ?? `run ${run.id}`}.`);
        return { requestId, runId: run.id, headSha: run.head_sha };
      }
    }
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - now())));
  }
}

export async function main(environment = process.env) {
  const result = await dispatchAndWaitForUnlock({
    repository: environment.GITHUB_REPOSITORY,
    token: environment.GITHUB_TOKEN ?? environment.GH_TOKEN,
    branch: environment.OTA_BRANCH || 'production',
    iosRuntime: environment.IOS_RUNTIME_VERSION || '',
    androidRuntime: environment.ANDROID_RUNTIME_VERSION || '',
  });
  if (environment.GITHUB_OUTPUT)
    appendFileSync(environment.GITHUB_OUTPUT, `run_id=${result.runId}\nrequest_id=${result.requestId}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
