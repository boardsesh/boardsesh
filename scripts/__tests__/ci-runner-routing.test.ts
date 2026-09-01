/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  githubYamlPaths,
  isRoutedRunsOn,
  jobBlocks,
  routedJobNames,
  withoutCommentLines,
} from './helpers/workflow-yaml';

/**
 * Routing between GitHub-hosted and the self-hosted homelab fleet.
 *
 * Every migrated job carries the SAME expression, byte for byte:
 *
 *   runs-on: ${{ fromJSON(github.event.pull_request.head.repo.fork && '"ubuntu-latest"' || vars.CI_RUNNER_LINUX || '"ubuntu-latest"') }}
 *
 * Two properties matter and neither is visible at review time.
 *
 * 1. The fork clause. boardsesh/boardsesh is public with 33 forks, and the
 *    self-hosted runners have no meaningful sandbox — jobs are in the `docker`
 *    group, which is root on the VM. Fork PRs must resolve to `ubuntu-latest`
 *    even though the repo also requires approval for outside collaborators;
 *    approving a diff is not the same as vouching for it running as root on the
 *    LAN. Paraphrase the expression and drop that clause and nothing looks
 *    wrong in review — hence the byte-identity check rather than a shape check.
 *
 * 2. The single kill switch. `vars.CI_RUNNER_LINUX` unset (or set to the JSON
 *    string "ubuntu-latest") puts everything back on GitHub-hosted with no
 *    commit. That only holds while every migrated job reads the same variable.
 *
 * Everything inside fromJSON is a JSON literal, so the result is always
 * well-typed: either the string "ubuntu-latest" or the label array from the
 * variable. On push/schedule/workflow_dispatch the fork property is null, so it
 * falls through to the variable.
 */

const ROUTING_EXPRESSION =
  '${{ fromJSON(github.event.pull_request.head.repo.fork && \'"ubuntu-latest"\' || vars.CI_RUNNER_LINUX || \'"ubuntu-latest"\') }}';

const ROUTED_RUNS_ON = `    runs-on: ${ROUTING_EXPRESSION}`;

/**
 * Jobs that are allowed to be routed. Anything else asking for a self-hosted
 * runner is a mistake — see ci-self-hosted-secret-boundary.test.ts for why the
 * deploy and release workflows may never be.
 */
const ROUTED_JOBS: ReadonlyArray<readonly [workflow: string, job: string]> = [
  // Wave 0 canaries: cheap, secret-free, and between them they exercise the
  // whole runner contract — GITHUB_TOKEN, checkout over a seeded git object
  // store, `vp install` against the warm pnpm store, and the hostedtoolcache
  // Python prefill.
  ['pr-test-plan.yml', 'check'],
  ['firmware-tests.yml', 'test'],
  // Wave 1: the measured worst offenders. Both gates are ~50s of work that
  // waited ~25 minutes for a slot (1475s and 1666s on runs 33465942874 and
  // 33465859594). Their macOS/APK build jobs stay hosted.
  ['ios-rn-ci.yml', 'gate'],
  ['android-pr-rn.yml', 'gate'],
];

/**
 * ci.yml's control plane. `changes` gates 22 jobs and `ci-status` is the
 * required check, so both must be able to run when the fleet cannot. Two of
 * GitHub's 20 slots is a cheap price for the aggregator always being able to
 * report.
 */
const CI_CONTROL_PLANE_JOBS = ['changes', 'ci-status'] as const;

function workflow(name: string): string {
  return readFileSync(`.github/workflows/${name}`, 'utf8');
}

describe('self-hosted runner routing', () => {
  it.each(ROUTED_JOBS)('%s job `%s` is routed', (workflowName, jobName) => {
    const block = jobBlocks(workflow(workflowName)).get(jobName);
    expect(block, `${workflowName} has no job \`${jobName}\``).toBeDefined();
    expect(block).toContain(ROUTED_RUNS_ON);
  });

  it('uses one byte-identical expression everywhere it appears', () => {
    // The failure this catches: someone copies the line, reformats it, and
    // drops the fork clause. The result still routes to the fleet, still reads
    // fine, and now runs fork PRs as root on the homelab.
    const variants = new Map<string, string[]>();

    for (const path of githubYamlPaths()) {
      for (const line of withoutCommentLines(readFileSync(path, 'utf8'))) {
        if (!isRoutedRunsOn(line)) continue;
        const expression = line.trim().slice('runs-on:'.length).trim();
        variants.set(expression, [...(variants.get(expression) ?? []), path]);
      }
    }

    expect(variants.size, `runs-on expressions drifted: ${JSON.stringify([...variants], null, 2)}`).toBe(1);
    expect([...variants.keys()][0]).toBe(ROUTING_EXPRESSION);
  });

  it('routes exactly the jobs on the list and no others', () => {
    const routed = new Set<string>();
    for (const path of githubYamlPaths()) {
      const workflowName = path.split('/').pop() as string;
      for (const jobName of routedJobNames(readFileSync(path, 'utf8'))) {
        routed.add(`${workflowName}:${jobName}`);
      }
    }

    const expected = new Set(ROUTED_JOBS.map(([workflowName, jobName]) => `${workflowName}:${jobName}`));
    // Adding a job here is a deliberate act that should come with a wave and a
    // measurement, not a drive-by edit.
    expect([...routed].sort()).toEqual([...expected].sort());
  });

  it('keeps ci.yml`s control plane on GitHub-hosted', () => {
    const blocks = jobBlocks(workflow('ci.yml'));
    for (const jobName of CI_CONTROL_PLANE_JOBS) {
      const block = blocks.get(jobName);
      expect(block, `ci.yml has no job \`${jobName}\``).toBeDefined();
      expect(block).toContain('    runs-on: ubuntu-latest');
    }
  });

  it('keeps the watchdog independent of the thing it watches', () => {
    // ci-runner-watchdog.yml is what puts the fleet back on GitHub-hosted when
    // the runners die. If it were routed, it could not run at exactly the
    // moment it is needed.
    const source = workflow('ci-runner-watchdog.yml');
    // It reads and writes CI_RUNNER_LINUX in its script, so assert on the
    // runs-on specifically rather than on the string appearing in the file.
    expect(routedJobNames(source)).toEqual([]);
    expect(jobBlocks(source).get('check')).toContain('    runs-on: ubuntu-latest');
  });
});
