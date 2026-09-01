/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { githubYamlPaths, isRoutedRunsOn, isWorkflow, jobBlocks, withoutCommentLines } from './helpers/workflow-yaml';

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
