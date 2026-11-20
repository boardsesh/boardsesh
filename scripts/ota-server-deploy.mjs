#!/usr/bin/env node
// The public repo dispatches only reviewed main commits. The private receiver
// independently validates the declaration, deploys, probes, then uploads a receipt.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readOtaHosting } from './lib/ota-hosting.mjs';

const TARGET_REPOSITORY = 'marcodejongh/blackheathdc-ansible';
const RECEIVER_WORKFLOW = 'boardsesh-ota-deploy.yml';
const APPEAR_BUDGET_MS = 10 * 60_000;
const WAIT_BUDGET_MS = 95 * 60_000;
const POLL_INTERVAL_MS = 20_000;
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function requireMain(env) {
  if (env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_REPOSITORY !== 'boardsesh/boardsesh') {
    throw new Error('OTA deployment requires boardsesh/boardsesh refs/heads/main');
  }
}

export function deploymentRequest(release, env) {
  requireMain(env);
  if (env.HOMELAB_DEPLOY_ENABLED !== 'true')
    throw new Error('HOMELAB_DEPLOY_ENABLED must be true; deployment is required');
  if (!env.HOMELAB_DISPATCH_TOKEN) throw new Error('HOMELAB_DISPATCH_TOKEN is missing');
  if (!SHA.test(env.GITHUB_SHA ?? '')) throw new Error('GITHUB_SHA must be a full commit SHA');
  if (!/^\d+$/.test(env.GITHUB_RUN_ID ?? '') || !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? '')) {
    throw new Error('GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT must be numeric');
  }
  if (
    release?.repository !== 'ghcr.io/mercuretechnologies/expo-open-ota' ||
    !VERSION.test(release.version ?? '') ||
    !DIGEST.test(release.digest ?? '')
  ) {
    throw new Error('Invalid immutable OTA server declaration');
  }
  return {
    source_sha: env.GITHUB_SHA,
    version: release.version,
    digest: release.digest,
    request_id: `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
    source_run_url: `https://github.com/boardsesh/boardsesh/actions/runs/${env.GITHUB_RUN_ID}`,
  };
}

export function matchingReceiverRun(runs, request) {
  const matches = runs.filter(
    (run) =>
      run.display_title === `Boardsesh OTA ${request.request_id}` &&
      run.event === 'repository_dispatch' &&
      run.head_branch === 'main',
  );
  if (matches.length > 1)
    throw new Error('Multiple receiver runs match the OTA request; refusing ambiguous acknowledgment');
  return matches[0] ?? null;
}

export function validateReceipt(receipt, request, receiverRunId) {
  for (const field of ['request_id', 'source_sha', 'version', 'digest']) {
    if (receipt?.[field] !== request[field]) throw new Error(`OTA receipt ${field} does not match the request`);
  }
  if (String(receipt.receiver_run_id) !== String(receiverRunId) || receipt.status !== 'verified') {
    throw new Error('OTA receipt does not prove this receiver run verified the deployment');
  }
  return receipt;
}

async function api(path, token, options = {}) {
  const response = await fetch(`https://api.github.com/repos/${TARGET_REPOSITORY}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`GitHub API HTTP ${response.status} for ${path.split('?')[0]}`);
  return response;
}

/** Prove the receiver's read permissions before the outage, without dispatching anything. */
export async function preflightRailwayHosting(env, { callApi = api, log = console.log } = {}) {
  log('OTA hosting remains Railway; Railway Config owns this release.');
  if (env.HOMELAB_DEPLOY_ENABLED !== 'true') {
    log('Homelab credential preflight not run: HOMELAB_DEPLOY_ENABLED is not true.');
    return false;
  }
  requireMain(env);
  if (!env.HOMELAB_DISPATCH_TOKEN) throw new Error('HOMELAB_DISPATCH_TOKEN is missing');
  for (const [path, field, label] of [
    [`/actions/workflows/${RECEIVER_WORKFLOW}/runs?branch=main&per_page=1`, 'workflow_runs', 'receiver workflow runs'],
    ['/actions/artifacts?per_page=1', 'artifacts', 'receiver artifacts'],
  ]) {
    let body;
    try {
      body = await (await callApi(path, env.HOMELAB_DISPATCH_TOKEN, { method: 'GET' })).json();
    } catch (error) {
      // The API wrapper's HTTP status is safe. Never echo response bodies,
      // transport errors, token values, private run names or artifact metadata.
      const status = /^GitHub API HTTP (\d{3}) for /.exec(error?.message ?? '')?.[1];
      throw new Error(
        `Homelab credential preflight could not read ${label}${status ? ` (HTTP ${status})` : ''}; ` +
          `HOMELAB_DISPATCH_TOKEN needs Actions: read on ${TARGET_REPOSITORY}, with the receiver registered on main.`,
      );
    }
    if (!Array.isArray(body?.[field])) throw new Error(`Homelab credential preflight received invalid ${label}`);
  }
  log(
    'Homelab credential preflight passed: receiver workflow runs and artifacts are readable. No deployment dispatched.',
  );
  return true;
}

async function receiptFor(run, request, token) {
  const body = await (await api(`/actions/runs/${run.id}/artifacts?per_page=100`, token)).json();
  const artifacts =
    body.artifacts?.filter(
      (artifact) => artifact.name === `boardsesh-ota-receipt-${request.request_id}` && !artifact.expired,
    ) ?? [];
  if (artifacts.length !== 1) throw new Error('Successful OTA receiver run has no unique deployment receipt');
  const response = await api(`/actions/artifacts/${artifacts[0].id}/zip`, token);
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length > 1024 * 1024) throw new Error('OTA deployment receipt archive exceeds 1 MiB');
  const directory = mkdtempSync(join(tmpdir(), 'ota-deploy-receipt-'));
  try {
    const archivePath = join(directory, 'receipt.zip');
    writeFileSync(archivePath, archive, { mode: 0o600 });
    // Never extract paths from the archive. Read only the agreed member to stdout.
    const raw = execFileSync('unzip', ['-p', archivePath, 'receipt.json'], { encoding: 'utf8', maxBuffer: 65536 });
    return validateReceipt(JSON.parse(raw), request, run.id);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function dispatchAndWait(
  request,
  token,
  {
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    callApi = api,
    readReceipt = receiptFor,
  } = {},
) {
  await callApi('/dispatches', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: 'boardsesh-ota-release', client_payload: request }),
  });
  const started = now();
  let readFailures = 0;
  for (;;) {
    if (now() - started > WAIT_BUDGET_MS) throw new Error('OTA receiver did not verify deployment within 95 minutes');
    let body;
    try {
      body = await (
        await callApi(
          `/actions/workflows/${RECEIVER_WORKFLOW}/runs?event=repository_dispatch&branch=main&per_page=100`,
          token,
        )
      ).json();
      if (!Array.isArray(body.workflow_runs)) throw new Error('GitHub returned no receiver workflow_runs');
      readFailures = 0;
    } catch (error) {
      if (++readFailures >= 5) throw error;
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    const run = matchingReceiverRun(body.workflow_runs, request);
    if (!run && now() - started > APPEAR_BUDGET_MS) throw new Error('OTA receiver run never appeared for this request');
    if (run?.status === 'completed') {
      if (run.conclusion !== 'success') throw new Error(`OTA receiver ${run.id} ended with ${run.conclusion}`);
      const receipt = await readReceipt(run, request, token);
      validateReceipt(receipt, request, run.id);
      console.log(`OTA verified: ${request.digest}, source ${request.source_sha}, receiver ${run.id}`);
      return receipt;
    }
    console.log(`Waiting for verified OTA deployment ${request.request_id}`);
    await sleep(POLL_INTERVAL_MS);
  }
}

async function main() {
  if (readOtaHosting() === 'railway') {
    await preflightRailwayHosting(process.env);
    return;
  }
  const release = JSON.parse(readFileSync(new URL('../infra/ota/server.json', import.meta.url), 'utf8'));
  const request = deploymentRequest(release, process.env);
  await dispatchAndWait(request, process.env.HOMELAB_DISPATCH_TOKEN);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
