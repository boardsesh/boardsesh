/// <reference types="node" />

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  githubYamlPaths,
  isRoutedRunsOn,
  isWorkflow,
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
  // Wave 0: the canary. Cheap, secret-free, and it exercises the core of the
  // runner contract -- GITHUB_TOKEN, checkout over a seeded git object store,
  // and `vp install` against the warm pnpm store.
  ['pr-test-plan.yml', 'check'],
  // Back after a detour: routing it first time round surfaced that the image
  // had no Python at all (setup-python only downloads Ubuntu builds, and this
  // image is Debian). The image now ships 3.11.16 and 3.12.14 in the tool
  // cache, verified in the published image by installing platformio.
  ['firmware-tests.yml', 'test'],
  // Wave 1: the measured worst offenders. Both gates are ~50s of work that
  // waited ~25 minutes for a slot (1475s and 1666s on runs 33465942874 and
  // 33465859594). Their macOS/APK build jobs stay hosted.
  ['ios-rn-ci.yml', 'gate'],
  ['android-pr-rn.yml', 'gate'],
  // Wave 2: ci.yml, everything that needs no service container and no Docker.
  //
  // NOT here, deliberately:
  //   changes / ci-status  -- the control plane. `changes` gates 22 jobs and
  //     `ci-status` is the required check, so both must be able to run when
  //     the fleet cannot.
  //   renderer-rust        -- dtolnay/rust-toolchain downloads a toolchain per
  //     job (the image carries no Rust) and Swatinem/rust-cache repeats the
  //     cache upload this wave exists to avoid. Same shape firmware-tests was
  //     in: it joins once the image can host it.
  //   db-migrations, test-backend, test-location-sync-integration, docker-web
  //     -- sub-wave B. Service containers on localhost ports, and buildx.
  //   lint, typecheck      -- both want ~6 GB against a slot's ~3.4 GB and are
  //     OOM-killed there. See MEMORY_BOUND_JOBS below and the comments on the
  //     jobs themselves.
  ['ci.yml', 'board-art-geometry'],
  ['ci.yml', 'board-render-version'],
  ['ci.yml', 'changelog-owned'],
  ['ci.yml', 'codegen-drift'],
  ['ci.yml', 'commit-lint'],
  ['ci.yml', 'deploy-config'],
  ['ci.yml', 'i18n'],
  ['ci.yml', 'large-files'],
  ['ci.yml', 'listing-guards'],
  ['ci.yml', 'mobile-bundle'],
  ['ci.yml', 'pg18-artifacts'],
  ['ci.yml', 'release-notes'],
  ['ci.yml', 'rest-surface'],
  ['ci.yml', 'test-default'],
  ['ci.yml', 'test-ocr'],
  ['ci.yml', 'test-report'],
];

/**
 * ci.yml's control plane. `changes` gates 22 jobs and `ci-status` is the
 * required check, so both must be able to run when the fleet cannot. Two of
 * GitHub's 20 slots is a cheap price for the aggregator always being able to
 * report.
 */
const CI_CONTROL_PLANE_JOBS = ['changes', 'ci-status'] as const;

/**
 * Jobs held on GitHub-hosted because a fleet slot cannot fit them, not because
 * of what they can reach.
 *
 * `lint` runs `vp check`, whose type-aware pass builds one TypeScript program
 * over the whole repo inside tsgolint. vite-plus 0.3.0 (oxlint-tsgolint
 * 0.23 -> 7.0.2001, #5108) pushed its peak to 5.0-5.6 GB; a slot's `--memory`
 * is ~3.4 GB, so the kernel OOM-killed tsgolint and every routed run of this
 * job failed with a bare exit 1. Replaying it in the CI image under the
 * launcher's bounds, it OOMs at 3.5/4.5/5.5 GB and passes at 6.0 GB, on both 2
 * and 3 vCPU. Re-route it when a slot can hand one job ~6 GB -- not before, and
 * not by tuning GOMEMLIMIT, which flipped between passing and OOMing run to run
 * on an unchanged image.
 */
const MEMORY_BOUND_JOBS = ['lint', 'typecheck'] as const;

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

  it('keeps memory-bound ci.yml jobs on GitHub-hosted', () => {
    // Routing `lint` back is a one-line edit that looks like tidying up, and it
    // fails as a bare "Process completed with exit code 1" with no log — the
    // OOM kill is only visible as `signal: 'SIGKILL'` inside a Node stack. Pin
    // it here so the edit has to argue with the measurement in MEMORY_BOUND_JOBS.
    const blocks = jobBlocks(workflow('ci.yml'));
    for (const jobName of MEMORY_BOUND_JOBS) {
      const block = blocks.get(jobName);
      expect(block, `ci.yml has no job \`${jobName}\``).toBeDefined();
      expect(block).toContain('    runs-on: ubuntu-latest');
    }
  });
});

describe('routed jobs must not save a dependency cache on the fleet', () => {
  // Measured on bs-ci-1-12: the setup-vp POST step (its cache save) took 148s
  // of a 210s job, against 0s on GitHub-hosted, because a self-hosted runner
  // uploads to GitHub's cache service over the open internet. It is also
  // redundant there -- the CI image bakes the pnpm store, which is why
  // `vp install` measured 1s on both. Left unguarded, migrating a workflow to
  // the fleet silently makes it several times SLOWER while still passing.
  //
  // This MUST follow local composite actions. The first version of this test
  // only read the workflow job block and passed while both Wave 1 gates still
  // paid the upload, because their `cache: true` lives in
  // .github/actions/mobile-native-gate rather than in the job.
  const cacheEnabled = /^\s*cache:\s*true\s*$/;
  // Actions differ in what their `cache` input accepts -- setup-vp takes a
  // boolean, setup-python a string like 'pip' -- so the invariant is that the
  // value is gated on runner.environment, not that it takes one exact form.
  const gated = /^\s*cache:\s*\$\{\{.*runner\.environment\s*==\s*'github-hosted'.*\}\}\s*$/;
  const localAction = /^\s*-?\s*uses:\s*\.\/(\.github\/actions\/[A-Za-z0-9._-]+)\s*$/;

  /** Job body plus every local composite action it reaches, transitively. */
  function reachableSources(jobLines: string[]): string[] {
    const collected = [jobLines.join('\n')];
    const pending = [...jobLines];
    const visited = new Set<string>();

    while (pending.length > 0) {
      const match = localAction.exec(pending.shift() ?? '');
      if (!match) continue;

      const actionDir = match[1];
      if (visited.has(actionDir)) continue;
      visited.add(actionDir);

      // action.yml or action.yaml, whichever exists.
      const actionPath = [`${actionDir}/action.yml`, `${actionDir}/action.yaml`].find((candidate) =>
        existsSync(candidate),
      );
      expect(actionPath, `${actionDir} is used but has no action.yml`).toBeDefined();

      const actionSource = readFileSync(actionPath as string, 'utf8');
      collected.push(actionSource);
      // Composites can invoke composites.
      pending.push(...actionSource.split('\n'));
    }
    return collected;
  }

  for (const workflowPath of githubYamlPaths()) {
    const source = readFileSync(workflowPath, 'utf8');
    if (!isWorkflow(source)) continue;

    const blocks = jobBlocks(source);
    for (const jobName of routedJobNames(source)) {
      const lines = reachableSources(blocks.get(jobName) ?? []).flatMap((text) => withoutCommentLines(text));

      it(`${workflowPath} :: ${jobName} gates every dependency cache it reaches`, () => {
        expect(
          lines.filter((line) => cacheEnabled.test(line)),
          `${jobName} runs on the fleet, so \`cache: true\` costs more than it saves ` +
            `(check the local composite actions it uses, not just the job body); ` +
            `gate it with \`cache: \${{ runner.environment == 'github-hosted' }}\``,
        ).toEqual([]);

        // Anything that configures caching at all must use the gated form.
        if (lines.some((line) => /^\s*cache:/.test(line))) {
          expect(lines.some((line) => gated.test(line))).toBe(true);
        }
      });
    }
  }
});
