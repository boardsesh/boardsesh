#!/usr/bin/env node
// Fail-closed wait used immediately before anything on main uploads to the OTA server.
//
// The CLI/server upload protocol must move together. The committed hosting
// provider selects the exact main-commit deployment workflow to wait for.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { otaDeployment, readOtaHosting, RAILWAY_APPLY_PATHS, touchesDeployment } from './lib/ota-hosting.mjs';

const SHA = /^[0-9a-f]{40}$/;
const POLL_INTERVAL_MS = 20_000;
/** Above the homelab sender's 100-minute job ceiling, including queue/setup time. */
const WAIT_BUDGET_MS = 110 * 60_000;
const RAILWAY_WAIT_BUDGET_MS = 85 * 60_000;
/** How long a run that should exist may take to appear after the push; GitHub can queue for minutes. */
const APPEAR_BUDGET_MS = 10 * 60_000;
/** Consecutive failed reads of the run list tolerated before giving up. */
const MAX_CONSECUTIVE_READ_FAILURES = 5;

/**
 * What to do given the selected deployment workflow runs for this commit.
 *
 * @param {{ runs: { status: string; conclusion: string | null }[]; expectRun: boolean; appearDeadlinePassed: boolean }} input
 * @returns {'proceed' | 'wait' | 'fail'}
 */
export function serverReadiness({ runs, expectRun, appearDeadlinePassed }) {
  if (runs.length === 0) {
    if (!expectRun) return 'proceed';
    // The commit changed deployment inputs, so a run is coming. Refuse to guess.
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

/**
 * True when a Railway Config run should exist for this push. Only pushes to main
 * trigger one. Other refs never start infrastructure deployment workflows.
 */
export function expectsRailwayRun({ ref, changedFiles }) {
  return ref === 'refs/heads/main' && touchesRailwayApply(changedFiles);
}

export function expectsOtaDeployment({ provider, ref, changedFiles }) {
  return ref === 'refs/heads/main' && touchesDeployment(changedFiles, otaDeployment(provider).paths);
}

export function pushBase(event) {
  // A push may contain several commits. HEAD~1 misses an upgrade in an earlier
  // commit and would allow publishing before its deployment run appears.
  return SHA.test(event?.before ?? '') && !/^0+$/.test(event.before) ? event.before : 'HEAD~1';
}

function changedFilesInHead() {
  try {
    const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
    const output = execFileSync('git', ['diff', '--name-only', pushBase(event), 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output.split('\n').filter(Boolean);
  } catch {
    // Without the parent commit this cannot tell whether a deployment run is
    // coming, and guessing "no" would let the publish race the rollout. Both callers
    // check out full history, so this only fires on a misconfigured checkout.
    throw new Error('Cannot diff HEAD against its parent; check out with fetch-depth: 0 before this gate.');
  }
}

/** Select the latest deployment of the release inherited by this main commit.
 * A mobile-only push must wait for an earlier server upgrade, and a multi-commit
 * push deploys at its head rather than at the individual commit that changed it.
 */
export function selectHomelabRuns(runs, requirement, git) {
  const eligible = runs.filter(
    (run) =>
      run.event === 'push' &&
      run.head_branch === 'main' &&
      SHA.test(run.head_sha ?? '') &&
      git.isAncestor(requirement.requiredSha, run.head_sha) &&
      git.isAncestor(run.head_sha, requirement.targetSha),
  );
  if (eligible.length === 0) return [];
  eligible.sort(
    (a, b) => git.distance(a.head_sha, requirement.targetSha) - git.distance(b.head_sha, requirement.targetSha),
  );
  const newestSha = eligible[0].head_sha;
  const release = git.releaseAt(newestSha);
  if (
    git.providerAt(newestSha) !== 'homelab' ||
    ['version', 'repository', 'digest'].some((field) => release?.[field] !== requirement.release[field])
  ) {
    throw new Error('Ancestor OTA deployment does not match the required homelab release');
  }
  return eligible.filter((run) => run.head_sha === newestSha);
}

function gitOutput(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const sourceEvidence = {
  isAncestor: (ancestor, descendant) => {
    try {
      gitOutput(['merge-base', '--is-ancestor', ancestor, descendant]);
      return true;
    } catch {
      return false;
    }
  },
  distance: (ancestor, descendant) => Number(gitOutput(['rev-list', '--count', `${ancestor}..${descendant}`])),
  releaseAt: (sha) => JSON.parse(gitOutput(['show', `${sha}:infra/ota/server.json`])),
  providerAt: (sha) => JSON.parse(gitOutput(['show', `${sha}:infra/ota/hosting.json`])).provider,
};

function inheritedReleaseRequirement(sha, deployment) {
  const requiredSha = gitOutput(['log', '--first-parent', '-1', '--format=%H', sha, '--', ...deployment.paths]);
  if (!SHA.test(requiredSha)) throw new Error('Cannot find the required OTA deployment ancestor; fetch full history.');
  return { targetSha: sha, requiredSha, release: sourceEvidence.releaseAt(sha) };
}

async function deploymentRunsFor(sha, workflow, ancestor = false) {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repository || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
  const url = new URL(`https://api.github.com/repos/${repository}/actions/workflows/${workflow}/runs`);
  if (!ancestor) url.searchParams.set('head_sha', sha);
  url.searchParams.set('branch', 'main');
  url.searchParams.set('per_page', '100');
  url.searchParams.set('event', 'push');
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    // Name the reason: a 403 is either a missing `actions: read` or a secondary rate limit.
    const reason = await response.text().catch(() => '');
    throw new Error(`GitHub API answered HTTP ${response.status} listing OTA deployment runs: ${reason.slice(0, 200)}`);
  }
  const body = await response.json();
  if (!Array.isArray(body.workflow_runs)) throw new Error('GitHub API returned no workflow_runs array');
  return body.workflow_runs.filter(
    (run) =>
      run.event === 'push' &&
      run.head_branch === 'main' &&
      SHA.test(run.head_sha ?? '') &&
      (ancestor || run.head_sha === sha),
  );
}

async function main() {
  const sha = process.env.GITHUB_SHA;
  if (!sha || !SHA.test(sha)) throw new Error('GITHUB_SHA must be a full commit SHA');
  const provider = readOtaHosting();
  const deployment = otaDeployment(provider);
  const requirement =
    provider === 'homelab' && process.env.GITHUB_REF === 'refs/heads/main'
      ? inheritedReleaseRequirement(sha, deployment)
      : null;
  const expectRun =
    requirement !== null ||
    expectsOtaDeployment({
      provider,
      ref: process.env.GITHUB_REF ?? '',
      changedFiles: changedFilesInHead(),
    });
  // Private run: 80 minutes + 10 to appear; sender: 95, outer job: 100.
  const waitBudgetMs = provider === 'homelab' ? WAIT_BUDGET_MS : RAILWAY_WAIT_BUDGET_MS;
  const started = Date.now();
  let consecutiveReadFailures = 0;
  for (;;) {
    let runs;
    try {
      runs = await deploymentRunsFor(sha, deployment.workflow, requirement !== null);
      if (requirement) runs = selectHomelabRuns(runs, requirement, sourceEvidence);
      consecutiveReadFailures = 0;
    } catch (error) {
      // A transient 5xx or timeout must not abort a publish mid-wait. Keep polling,
      // and give up only when the API stays unreadable.
      consecutiveReadFailures += 1;
      if (consecutiveReadFailures >= MAX_CONSECUTIVE_READ_FAILURES) throw error;
      console.log(`::warning::${error instanceof Error ? error.message : String(error)}; retrying.`);
      await new Promise((done) => setTimeout(done, POLL_INTERVAL_MS));
      continue;
    }
    const decision = serverReadiness({
      runs,
      expectRun,
      appearDeadlinePassed: Date.now() - started > APPEAR_BUDGET_MS,
    });
    if (decision === 'proceed') {
      console.log(
        runs.length === 0
          ? `OTA server ready: no ${deployment.name} run required for ${sha}.`
          : `OTA server ready: ${deployment.name} at ${runs[0].head_sha ?? sha} verified the release required by ${sha}.`,
      );
      return;
    }
    if (decision === 'fail') {
      const summary =
        runs.length === 0 ? 'never started' : runs.map((run) => `${run.id}: ${run.conclusion}`).join(', ');
      throw new Error(
        `${deployment.name} for ${sha} did not succeed (${summary}); the OTA server may not run the ` +
          'version this commit publishes with. Fix or revert the apply before publishing.',
      );
    }
    if (Date.now() - started > waitBudgetMs) {
      throw new Error(`${deployment.name} for ${sha} was still running after ${waitBudgetMs / 60_000} minutes.`);
    }
    console.log(`Waiting for ${deployment.name} on ${sha} to finish rolling the OTA server...`);
    await new Promise((done) => setTimeout(done, POLL_INTERVAL_MS));
  }
}

if (process.argv[1]?.endsWith('mobile-ota-server-ready.mjs')) {
  main().catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
