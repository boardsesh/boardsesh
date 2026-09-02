/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  githubYamlPaths,
  isDeployRoutedRunsOn,
  isRoutedRunsOn,
  isWorkflow,
  jobBlocks,
  withoutCommentLines,
} from './helpers/workflow-yaml';

/**
 * The invariant that makes self-hosted runners acceptable at all:
 *
 *   No job routed to the homelab fleet may reference any secret other than
 *   `secrets.GITHUB_TOKEN`, and none may declare an `environment:`.
 *
 * Why it has to be a test rather than a rule people remember:
 *
 * A self-hosted runner has no meaningful boundary between a job and the host.
 * Jobs are in the `docker` group (root-equivalent), and the runner's own
 * `.credentials` file must be readable by the runner user — so a job that reads
 * it can impersonate the runner and receive *subsequent* jobs, including their
 * secrets. That is inherent to self-hosted runners, not a bug we can fix. The
 * only durable mitigation is that there is nothing on the fleet worth stealing.
 *
 * The good news is this costs nothing today: ci.yml already references only
 * `GITHUB_TOKEN`. The rule keeps App Store Connect, Google Play, Vercel,
 * Railway, Cloudflare, AWS, the OTA admin credentials, Sentry and the
 * 1Password service account off homelab hardware by construction.
 *
 * Deploy and release work moves to a *separate protected fleet* later — a
 * different trust domain that never runs PR code — not onto this one.
 */

const ALLOWED_SECRET = 'GITHUB_TOKEN';

/**
 * The ONE deliberate exception to the invariant above, written out so it is
 * argued rather than assumed.
 *
 * production-deploy.yml's two image builds may run on the fleet, via the
 * separate `DEPLOY_RUNNER_LINUX` variable, so that a BuildKit daemon which
 * outlives the ephemeral job container can keep `--mount=type=cache` warm —
 * the pnpm store and Turbopack's build database. That is worth real minutes on
 * a workflow whose concurrency group is serialised.
 *
 * What it costs, stated plainly: the runner container is not a security
 * boundary (Dockerfile.ci says so), jobs hold the host docker socket, and a job
 * can read a later job's environment. So anyone who can get a step onto `bs-ci`
 * can obtain these two secrets. SENTRY_AUTH_TOKEN is a source-map upload token;
 * GITHUB_TOKEN here carries `packages: write`, i.e. the ability to move the
 * `:production` GHCR tag that Railway pulls. Fork PRs cannot reach the fleet,
 * so the exposure is to people with write access, not the internet.
 *
 * What is deliberately NOT on this list: `migrate` (DATABASE_URL — production
 * Postgres) and every deploy job (RAILWAY_TOKEN). Those stay GitHub-hosted.
 *
 * The end state remains a separate `bs-deploy` host that never runs PR code, as
 * the invariant above describes. Until then this list is the whole exception,
 * and adding to it should be as uncomfortable as it looks.
 */
const DEPLOY_FLEET_ALLOWLIST: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'build-web': Object.freeze(['GITHUB_TOKEN', 'SENTRY_AUTH_TOKEN']),
  'build-backend': Object.freeze(['GITHUB_TOKEN']),
});

/** `secrets.FOO` / `secrets['FOO']` / `secrets["FOO"]`. */
const SECRET_REFERENCE = /secrets\.([A-Za-z0-9_]+)|secrets\[['"]([A-Za-z0-9_]+)['"]\]/g;

function secretNames(text: string): string[] {
  return [...text.matchAll(SECRET_REFERENCE)].map((match) => match[1] ?? match[2]);
}

interface RoutedJob {
  path: string;
  jobName: string;
  block: string[];
  source: string;
}

function routedJobs(): RoutedJob[] {
  const jobs: RoutedJob[] = [];
  for (const path of githubYamlPaths()) {
    const source = readFileSync(path, 'utf8');
    // .github also holds composite actions and dependabot config, which have no
    // top-level `jobs:` key.
    if (!isWorkflow(source)) continue;
    for (const [jobName, block] of jobBlocks(source)) {
      if (block.some(isRoutedRunsOn)) {
        jobs.push({ path, jobName, block, source });
      }
    }
  }
  return jobs;
}

describe('self-hosted secret boundary', () => {
  const jobs = routedJobs();

  it('finds the routed jobs (guards against the checks below passing vacuously)', () => {
    // Without this, deleting the routing expression everywhere would make every
    // assertion below pass on an empty set.
    expect(jobs.length).toBeGreaterThan(0);
  });

  it('routes no job that references a secret other than GITHUB_TOKEN', () => {
    const offenders = jobs.flatMap(({ path, jobName, block }) =>
      secretNames(block.join('\n'))
        .filter((name) => name !== ALLOWED_SECRET)
        .map((name) => `${path}:${jobName} → secrets.${name}`),
    );
    expect(offenders).toEqual([]);
  });

  it('routes no job whose workflow-level env references a secret other than GITHUB_TOKEN', () => {
    // A workflow-level `env:` is inherited by every job in the file, so a
    // routed job in a workflow with a secret up top is just as exposed as one
    // that names it directly.
    const offenders: string[] = [];
    for (const path of new Set(jobs.map((job) => job.path))) {
      const lines = withoutCommentLines(readFileSync(path, 'utf8'));
      const envIndex = lines.findIndex((line) => line === 'env:');
      if (envIndex < 0) continue;
      for (const line of lines.slice(envIndex + 1)) {
        if (!line.trim()) continue;
        if (!line.startsWith('  ')) break;
        for (const name of secretNames(line)) {
          if (name !== ALLOWED_SECRET) offenders.push(`${path} → workflow env secrets.${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('routes no job that declares an environment', () => {
    // GitHub Environments are how the high-value secrets are gated today
    // (Production, ota-preview, ota-preview-unattended, postgres-image-publisher).
    // An `environment:` on a routed job hands that environment's secrets to the
    // fleet, which is exactly what this boundary exists to prevent.
    const offenders = jobs
      .filter(({ block }) => block.some((line) => /^ {4}environment:/.test(line)))
      .map(({ path, jobName }) => `${path}:${jobName}`);
    expect(offenders).toEqual([]);
  });

  it('routes no job in a workflow that can be triggered by pull_request_target', () => {
    // pull_request_target runs with the base repo's token and secrets while
    // checking out PR-author-controlled refs. Combining that with a runner that
    // has no sandbox is the worst available shape.
    const offenders = jobs
      .filter(({ source }) => withoutCommentLines(source).some((line) => /^\s{2}pull_request_target:/.test(line)))
      .map(({ path, jobName }) => `${path}:${jobName}`);
    expect(offenders).toEqual([]);
  });
});

/**
 * Jobs routed through `DEPLOY_RUNNER_LINUX`. Collected separately from
 * routedJobs() because they are the exception, not the rule — see
 * DEPLOY_FLEET_ALLOWLIST.
 */
function deployRoutedJobs(): RoutedJob[] {
  const jobs: RoutedJob[] = [];
  for (const path of githubYamlPaths()) {
    const source = readFileSync(path, 'utf8');
    if (!isWorkflow(source)) continue;
    for (const [jobName, block] of jobBlocks(source)) {
      if (block.some(isDeployRoutedRunsOn)) {
        jobs.push({ path, jobName, block, source });
      }
    }
  }
  return jobs;
}

describe('deploy fleet routing (the one deliberate exception)', () => {
  const jobs = deployRoutedJobs();

  it('routes only the jobs on the allowlist', () => {
    // The allowlist is the argument. A job appearing here that nobody wrote a
    // justification for is the regression this catches.
    expect(jobs.map((job) => job.jobName).sort()).toEqual(Object.keys(DEPLOY_FLEET_ALLOWLIST).sort());
    for (const job of jobs) {
      expect(job.path, job.jobName).toBe('.github/workflows/production-deploy.yml');
    }
  });

  it('carries only the secrets its allowlist entry accounts for', () => {
    const offenders = jobs.flatMap(({ jobName, block }) => {
      const allowed = DEPLOY_FLEET_ALLOWLIST[jobName] ?? [];
      return [...new Set(secretNames(block.join('\n')))]
        .filter((name) => !allowed.includes(name))
        .map((name) => `${jobName} → secrets.${name} (not in DEPLOY_FLEET_ALLOWLIST)`);
    });
    expect(offenders).toEqual([]);
  });

  it('keeps the database and Railway credentials off the fleet', () => {
    // The line that matters most. These are not "a token someone could abuse";
    // they are production Postgres and the ability to redeploy any service.
    const forbidden = ['DATABASE_URL', 'RAILWAY_TOKEN'];
    const offenders = jobs.flatMap(({ jobName, block }) =>
      secretNames(block.join('\n'))
        .filter((name) => forbidden.includes(name))
        .map((name) => `${jobName} → secrets.${name}`),
    );
    expect(offenders).toEqual([]);
  });

  it('uses a builder instance that no PR-code job can share', () => {
    // A job whose Dockerfile is attacker-controlled sharing this daemon could
    // write a trojaned package into the shared pnpm-store cache mount, and the
    // next production build would install it into a published, attested image.
    // The daemon name is the isolation, so it is asserted rather than trusted.
    const workflow = readFileSync('.github/workflows/production-deploy.yml', 'utf8');
    expect(workflow).toContain('docker-container://boardsesh-buildkitd-deploy');
    for (const path of githubYamlPaths()) {
      if (path === '.github/workflows/production-deploy.yml') continue;
      expect(readFileSync(path, 'utf8'), path).not.toContain('boardsesh-buildkitd-deploy');
    }
  });

  it('is left OFF by default, so merging the wiring is a no-op', () => {
    // `fromJSON(vars.X || '"ubuntu-latest"')` — an unset variable means
    // GitHub-hosted. Flipping it is a deliberate, separately-revertible act.
    const workflow = readFileSync('.github/workflows/production-deploy.yml', 'utf8');
    expect(workflow).toContain(`fromJSON(vars.DEPLOY_RUNNER_LINUX || '"ubuntu-latest"')`);
  });

  it('is reset by the runner watchdog alongside the CI variable', () => {
    // `runs-on` resolves at dispatch, and a queued fleet job holds the
    // production-deploy concurrency group silently. The watchdog resetting only
    // CI_RUNNER_LINUX would leave deploys wedged for 24h.
    const watchdog = readFileSync('.github/workflows/ci-runner-watchdog.yml', 'utf8');
    expect(watchdog).toContain('DEPLOY_RUNNER_LINUX');
    expect(watchdog).toMatch(/routing_variables=\(CI_RUNNER_LINUX DEPLOY_RUNNER_LINUX\)/);
  });
});
