/// <reference types="node" />
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const ORIGIN = 'https://updates.boardsesh.com';
const REPOSITORY = 'boardsesh/boardsesh';
const WORKFLOW = 'ota-public-health.yml';
const ENDPOINTS = ['/hc', '/ready'] as const;
const ATTEMPTS = 3;
const TIMEOUT_MS = 10_000;
const RETRY_MS = 5_000;

interface Attempt {
  path: (typeof ENDPOINTS)[number];
  attempt: number;
  status: number;
  latencyMs: number;
}

/** Anonymous GETs only. Never read or log the response body, headers, or error text. */
export async function probePublicHealth({
  fetchImpl = fetch,
  sleepImpl = sleep,
  now = performance.now.bind(performance),
  timeoutMs = TIMEOUT_MS,
}: {
  fetchImpl?: typeof fetch;
  sleepImpl?: (delayMs: number) => Promise<unknown>;
  now?: () => number;
  timeoutMs?: number;
} = {}) {
  const endpoints = await Promise.all(
    ENDPOINTS.map(async (path) => {
      const attempts: Attempt[] = [];
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        const started = now();
        let status = 0;
        try {
          const response = await fetchImpl(`${ORIGIN}${path}`, {
            method: 'GET',
            redirect: 'manual',
            signal: AbortSignal.timeout(timeoutMs),
          });
          status = response.status;
          await response.body?.cancel();
        } catch {
          // Zero means no usable HTTP response, including a network timeout.
          status = 0;
        }
        attempts.push({ path, attempt, status, latencyMs: Math.max(0, Math.round(now() - started)) });
        if (status === 200) return { healthy: true, attempts };
        if (attempt < ATTEMPTS) await sleepImpl(RETRY_MS);
      }
      return { healthy: false, attempts };
    }),
  );
  return {
    healthy: endpoints.every((endpoint) => endpoint.healthy),
    attempts: endpoints.flatMap((endpoint) => endpoint.attempts),
  };
}

interface WorkflowRun {
  id: number;
  head_branch: string;
  event: string;
}

/** Use the probe job's outcome, so a Discord failure cannot invent an OTA outage. */
export async function previousProbeConclusion(
  runId: number,
  token: string,
  fetchImpl = fetch,
): Promise<'success' | 'failure' | null> {
  const read = async (path: string): Promise<unknown> => {
    const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error('Could not read previous public-health results');
    return response.json();
  };
  const body = (await read(`/actions/workflows/${WORKFLOW}/runs?branch=main&status=completed&per_page=20`)) as {
    workflow_runs?: WorkflowRun[];
  };
  if (!Array.isArray(body.workflow_runs)) throw new Error('Missing previous public-health runs');
  const runs = body.workflow_runs
    .filter(
      (run) =>
        Number.isSafeInteger(run?.id) &&
        run.id > 0 &&
        run.id < runId &&
        run.head_branch === 'main' &&
        ['schedule', 'workflow_dispatch'].includes(run.event),
    )
    .sort((a, b) => b.id - a.id);
  for (const run of runs) {
    const body = (await read(`/actions/runs/${run.id}/jobs?per_page=100`)) as {
      jobs?: { name: string; conclusion: string }[];
    };
    if (!Array.isArray(body.jobs)) throw new Error('Missing previous public-health jobs');
    const probes = body.jobs.filter((job) => job?.name === 'probe');
    if (probes.length !== 1) continue;
    if (probes[0].conclusion === 'success') return 'success';
    if (['failure', 'timed_out'].includes(probes[0].conclusion)) return 'failure';
  }
  return null;
}

export async function notifyPublicHealth({
  healthy,
  runId,
  token,
  webhook,
  fetchImpl = fetch,
}: {
  healthy: boolean;
  runId: number;
  token: string;
  webhook: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error('Invalid public-health run ID');
  if (healthy && (await previousProbeConclusion(runId, token, fetchImpl)) !== 'failure') return false;
  if (!webhook) throw new Error('DISCORD_DEPLOY_WEBHOOK is not configured; see the public-health run');
  const content = healthy
    ? '**OTA public health recovered:** /hc and /ready both return HTTP 200 from a GitHub-hosted runner.'
    : '**OTA public health failed:** Could not confirm HTTP 200 from both /hc and /ready. See the run for response codes and latency.';
  const response = await fetchImpl(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: `${content}\nhttps://github.com/${REPOSITORY}/actions/runs/${runId}`,
      allowed_mentions: { parse: [] },
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error('Discord delivery failed; see the public-health run');
  return true;
}

function homelabOwnsOta(): boolean {
  const value = JSON.parse(readFileSync(new URL('../infra/ota/hosting.json', import.meta.url), 'utf8')) as {
    provider?: string;
  };
  if (value.provider !== 'railway' && value.provider !== 'homelab') throw new Error('Unknown OTA hosting provider');
  return value.provider === 'homelab';
}

async function main(): Promise<void> {
  if (process.env.GITHUB_REF !== 'refs/heads/main' || process.env.GITHUB_REPOSITORY !== REPOSITORY)
    throw new Error('Public health only runs from Boardsesh main');
  const command = process.argv[2];
  if (!['probe', 'notify'].includes(command)) throw new Error('Expected probe or notify');
  const enabled = homelabOwnsOta();
  if (command === 'probe' && process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `enabled=${enabled}\n`);
  if (!enabled) {
    console.log('OTA hosting remains Railway; public-health monitoring is inactive.');
    return;
  }
  if (command === 'notify') {
    await notifyPublicHealth({
      healthy: process.env.HEALTHY === 'true',
      runId: Number(process.env.GITHUB_RUN_ID),
      token: process.env.GH_TOKEN ?? '',
      webhook: process.env.DISCORD_DEPLOY_WEBHOOK ?? '',
    });
    return;
  }
  const result = await probePublicHealth();
  const rows = result.attempts.map(
    ({ path, attempt, status, latencyMs }) => `${path} attempt=${attempt} HTTP=${status} latency_ms=${latencyMs}`,
  );
  console.log(rows.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### OTA public health\n\n\`\`\`text\n${rows.join('\n')}\n\`\`\`\n`,
    );
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `healthy=${result.healthy}\n`);
  if (!result.healthy) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error('::error::OTA public-health check or notification could not complete; inspect the failed step.');
    process.exitCode = 1;
  });
}
