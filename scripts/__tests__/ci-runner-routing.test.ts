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
  ['ci.yml', 'board-art-geometry'],
  ['ci.yml', 'board-render-version'],
  ['ci.yml', 'changelog-owned'],
  ['ci.yml', 'codegen-drift'],
  ['ci.yml', 'commit-lint'],
  ['ci.yml', 'deploy-config'],
  ['ci.yml', 'i18n'],
  ['ci.yml', 'large-files'],
  ['ci.yml', 'lint'],
  ['ci.yml', 'listing-guards'],
  ['ci.yml', 'mobile-bundle'],
  ['ci.yml', 'pg18-artifacts'],
  ['ci.yml', 'release-notes'],
  ['ci.yml', 'rest-surface'],
  ['ci.yml', 'test-default'],
  ['ci.yml', 'test-ocr'],
  ['ci.yml', 'test-report'],
  ['ci.yml', 'typecheck'],
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

  describe('ci-runner-watchdog.yml safety properties', () => {
    // These are string-based, like the rest of this file: the watchdog's
    // script is bash embedded in YAML, so there is no AST to assert against.
    // Each check is deliberately tied to the actual protective mechanism
    // (the variable/loop that does the work), not just to log-message
    // wording, so a regression that removes the mechanism fails the test
    // even if the surrounding prose is left untouched.

    function watchdogScript(): string {
      const block = jobBlocks(workflow('ci-runner-watchdog.yml')).get('check');
      if (!block) throw new Error('ci-runner-watchdog.yml has no `check` job');
      return block.join('\n');
    }

    it('fails the job rather than warning when the admin PAT is missing', () => {
      // A missing/revoked CI_RUNNER_ADMIN_PAT used to `exit 0` after an
      // `::warning::` -- every scheduled firing looked green while the
      // watchdog was silently a no-op. Isolate the missing-PAT branch (from
      // the message that names the secret to the next top-level read, which
      // only runs once the PAT is known to be present) and assert it exits
      // non-zero, not zero.
      const script = watchdogScript();
      const branchStart = script.indexOf('CI_RUNNER_ADMIN_PAT is not set');
      // Anchored on the routing-variable read that follows, which only runs
      // once the PAT is known to be present.
      const branchEnd = script.indexOf('routing_variables=(', branchStart);
      expect(branchStart, 'expected a message naming CI_RUNNER_ADMIN_PAT').toBeGreaterThan(-1);
      expect(branchEnd, 'expected the missing-PAT branch to be followed by the routing-variable read').toBeGreaterThan(
        branchStart,
      );

      const missingPatBranch = script.slice(branchStart, branchEnd);
      expect(missingPatBranch).toContain('exit 1');
      expect(missingPatBranch).not.toMatch(/exit 0/);
    });

    it('only cancels queued runs whose jobs carry the bs-ci label', () => {
      // `gh run list --status queued` (or the run-listing API) returns every
      // queued run in the repo, including ones legitimately waiting on a
      // GitHub-hosted slot. Cancelling straight off that list is collateral
      // damage. The fix opens each run's jobs and filters to `bs-ci` before
      // building the list this loop cancels -- assert the cancel loop
      // iterates that filtered array, not a raw queued-run listing.
      const script = watchdogScript();
      expect(script).toMatch(/actions\/runs\/\$\{run_id\}\/jobs/);
      expect(script).toContain('bs-ci');
      expect(script).toMatch(/for run_id in "\$\{fleet_bound_run_ids\[@\]\}"/);

      const cancelIndex = script.indexOf('gh run cancel');
      const loopIndex = script.indexOf('for run_id in "${fleet_bound_run_ids[@]}"');
      expect(loopIndex, 'expected the cancel loop to iterate the label-filtered array').toBeGreaterThan(-1);
      expect(cancelIndex).toBeGreaterThan(loopIndex);
    });

    it('never claims cancelling a run makes it re-dispatch', () => {
      // Cancelling a queued run does not cause GitHub to automatically
      // re-run it -- that needs a human to push again or re-run by hand. An
      // earlier version of this workflow claimed the opposite in its own
      // comments and Discord message. Every mention of "re-dispatch" in the
      // script must be negated nearby (not/never/doesn't/won't), not
      // asserted as something cancelling causes. Checking proximity to a
      // negation, rather than one exact phrase, so a rewording of the
      // sentence around any one of the four mentions (two comments, the log
      // line, the Discord payload) can't slip the false claim back in
      // unnoticed.
      const script = watchdogScript();
      const mentions = [...script.matchAll(/re-dispatch/gi)];
      expect(mentions.length, 'expected the script to discuss re-dispatch behaviour').toBeGreaterThan(0);

      const negationWindow = 40;
      for (const mention of mentions) {
        const matchIndex = mention.index ?? 0;
        const contextStart = Math.max(0, matchIndex - negationWindow);
        const context = script.slice(contextStart, matchIndex).toLowerCase();
        expect(
          context,
          `"re-dispatch" at index ${matchIndex} has no negation in the ${negationWindow} chars before it: ${JSON.stringify(context)}`,
        ).toMatch(/\b(not|never|n't)\b/);
      }
    });

    it('paginates the self-hosted runners lookup instead of trusting a single page', () => {
      // The planned fleet is 36 runners, past the API's 30-per-page default.
      // Reading only page one under-counts online runners and can trip the
      // watchdog into flipping a healthy fleet back to GitHub-hosted.
      //
      // Matched without pinning the URL's exact tail: the page size moved into
      // the query string when the `-F per_page=100` form turned out to switch
      // `gh api` to POST, and this assertion still searched for the old
      // `actions/runners"` shape -- so it broke on a change that was correct.
      const script = watchdogScript();
      const runnersCallIndex = script.indexOf('actions/runners');
      expect(runnersCallIndex, 'expected a call to the runners endpoint').toBeGreaterThan(-1);
      const runnersCallLine = script.slice(Math.max(0, runnersCallIndex - 120), runnersCallIndex + 40);
      expect(runnersCallLine).toContain('--paginate');
      // Page size must still be requested, wherever it is expressed.
      expect(runnersCallLine).toContain('per_page=100');
    });
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
