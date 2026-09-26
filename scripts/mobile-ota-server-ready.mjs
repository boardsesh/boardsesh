#!/usr/bin/env node
// Fail-closed wait used immediately before anything on main uploads to the OTA server.
//
// The eoas CLI and the xprem server speak an upload protocol that has broken in both
// directions before (3.2.0 replaced `fileNames` with `files`, with no fallback either
// way). So a PR that bumps EOAS_PACKAGE_SPEC and OTA_SERVER_VERSION together is only
// safe if the server image has actually rolled before the new CLI publishes. On that
// push, two workflows run at once: Railway Config (railway-drift.yml) rolls the image,
// and production-deploy.yml stages and promotes an OTA. This makes the OTA side wait
// for the Railway side on the same commit.
//
// Most pushes never touch infra/railway/, so no Railway Config run exists and this
// returns at once. When one exists, it waits for it to finish and fails unless it
// succeeded: a failed apply has rolled the server back, and publishing with a CLI the
// server does not speak would fail anyway, only later and less clearly.
import { execFileSync } from 'node:child_process';

const SHA = /^[0-9a-f]{40}$/;
const RAILWAY_WORKFLOW_FILE = 'railway-drift.yml';
/** Paths whose change on a push to main triggers the Railway Config apply job. */
const RAILWAY_APPLY_PATHS = [
  'infra/railway/',
  'scripts/railway-apply.ts',
  'scripts/railway-deployment-rollback.mjs',
  '.github/workflows/railway-drift.yml',
];
const POLL_INTERVAL_MS = 20_000;
/** Above the apply job's own 50-minute timeout, so a slow rollback is waited out rather than raced. */
const WAIT_BUDGET_MS = 55 * 60_000;
/** How long a run that should exist may take to appear after the push. */
const APPEAR_BUDGET_MS = 3 * 60_000;

/**
 * What to do given the Railway Config runs for this commit.
 *
 * @param {{ runs: { status: string; conclusion: string | null }[]; expectRun: boolean; appearDeadlinePassed: boolean }} input
 * @returns {'proceed' | 'wait' | 'fail'}
 */
export function serverReadiness({ runs, expectRun, appearDeadlinePassed }) {
  if (runs.length === 0) {
    if (!expectRun) return 'proceed';
    // The commit changed the Railway config, so a run is coming. Refuse to guess.
    return appearDeadlinePassed ? 'fail' : 'wait';
  }
  if (runs.some((run) => run.status !== 'completed')) return 'wait';
  return runs.every((run) => run.conclusion === 'success') ? 'proceed' : 'fail';
}

/** True when the diff between two commits touches a path the Railway apply job watches. */
export function touchesRailwayApply(changedFiles) {
  return changedFiles.some((file) =>
    RAILWAY_APPLY_PATHS.some((path) => (path.endsWith('/') ? file.startsWith(path) : file === path)),
  );
}

function changedFilesInHead() {
  try {
    const output = execFileSync('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output.split('\n').filter(Boolean);
  } catch {
    // No parent in this checkout. Fall back to trusting the run list alone.
    return [];
  }
}

async function railwayRunsFor(sha) {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repository || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
  const url = new URL(`https://api.github.com/repos/${repository}/actions/workflows/${RAILWAY_WORKFLOW_FILE}/runs`);
  url.searchParams.set('head_sha', sha);
  url.searchParams.set('event', 'push');
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`GitHub API answered HTTP ${response.status} listing Railway Config runs`);
  const body = await response.json();
  if (!Array.isArray(body.workflow_runs)) throw new Error('GitHub API returned no workflow_runs array');
  return body.workflow_runs.map((run) => ({ id: run.id, status: run.status, conclusion: run.conclusion }));
}

async function main() {
  const sha = process.env.GITHUB_SHA;
  if (!sha || !SHA.test(sha)) throw new Error('GITHUB_SHA must be a full commit SHA');
  const expectRun = touchesRailwayApply(changedFilesInHead());
  const started = Date.now();
  for (;;) {
    const runs = await railwayRunsFor(sha);
    const decision = serverReadiness({
      runs,
      expectRun,
      appearDeadlinePassed: Date.now() - started > APPEAR_BUDGET_MS,
    });
    if (decision === 'proceed') {
      console.log(
        runs.length === 0
          ? `OTA server ready: no Railway Config run for ${sha}.`
          : `OTA server ready: Railway Config for ${sha} succeeded.`,
      );
      return;
    }
    if (decision === 'fail') {
      const summary =
        runs.length === 0 ? 'never started' : runs.map((run) => `${run.id}: ${run.conclusion}`).join(', ');
      throw new Error(
        `Railway Config for ${sha} did not succeed (${summary}); the OTA server may not run the ` +
          'version this commit publishes with. Fix or revert the apply before publishing.',
      );
    }
    if (Date.now() - started > WAIT_BUDGET_MS) {
      throw new Error(`Railway Config for ${sha} was still running after 55 minutes.`);
    }
    console.log(`Waiting for Railway Config on ${sha} to finish rolling the OTA server...`);
    await new Promise((done) => setTimeout(done, POLL_INTERVAL_MS));
  }
}

if (process.argv[1]?.endsWith('mobile-ota-server-ready.mjs')) {
  main().catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
