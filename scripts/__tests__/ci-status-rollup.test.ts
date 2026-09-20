/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { jobBlocks } from './helpers/workflow-yaml';

/**
 * `ci-status` is the one context main's branch protection requires (see
 * docs/ci-required-checks.md), which makes it the whole answer to two different
 * questions at once:
 *
 *   * "did CI pass?" — only if every gating job is in its `needs`. A job that is
 *     missing goes red on its own without turning the roll-up red, and nothing
 *     downstream looks at the individual jobs.
 *   * "did CI run at all?" — a required check that was never reported reads as
 *     *expected / waiting*, not as pass. That is the #4758 fix: a dropped
 *     `pull_request` delivery leaves the rollup empty, and an empty rollup is
 *     indistinguishable from a green one to `gh pr checks` and to a human.
 *
 * Both properties fail open. Nothing turns red when a new job forgets to join
 * the roll-up, so re-derive the job list from the workflow here rather than
 * pinning a copy of it.
 */

const workflowSource = readFileSync('.github/workflows/ci.yml', 'utf8');
const jobs = jobBlocks(workflowSource);

/**
 * Jobs that legitimately stay out of `ci-status`. Every entry needs a reason a
 * reviewer would accept for "this may fail while the required check is green".
 */
const ROLLUP_EXEMPT: Record<string, string> = {
  // Posts the test-results comment with report-fail-on-error: false, and skips
  // outright when every test job was skipped. A reporting hiccup (a missing
  // artifact, a flaky comment API) must never be the reason a PR cannot merge.
  'test-report': 'reporter, not a gate',
};

/** The `needs:` block-sequence entries of a job. */
function jobNeeds(jobName: string): string[] {
  const block = jobs.get(jobName);
  if (!block) throw new Error(`ci.yml has no \`${jobName}\` job`);

  const needsIndex = block.findIndex((line) => line.trim() === 'needs:');
  if (needsIndex < 0) return [];

  const collected: string[] = [];
  for (const line of block.slice(needsIndex + 1)) {
    const entry = /^ {6}- ([A-Za-z0-9_-]+)\s*$/.exec(line);
    if (!entry) break;
    collected.push(entry[1]);
  }
  return collected;
}

describe('ci-status is a complete roll-up', () => {
  const rollupNeeds = jobNeeds('ci-status');

  it('depends on every gating job in the workflow', () => {
    const missing = [...jobs.keys()].filter(
      (jobName) => jobName !== 'ci-status' && !(jobName in ROLLUP_EXEMPT) && !rollupNeeds.includes(jobName),
    );

    expect(
      missing,
      'These jobs can fail while `ci-status` stays green, and `ci-status` is the required check — ' +
        'add them to its `needs:`, or add them to ROLLUP_EXEMPT with the reason their failure is allowed to merge.',
    ).toEqual([]);
  });

  it('keeps large-files in the roll-up', () => {
    // Regression pin for #4758. `large-files` is deliberately ungated (a
    // binary-only PR is the shape it exists to catch) and was the one real gate
    // outside the roll-up, so an oversized file failed CI without failing the
    // context a merge gate reads.
    expect(rollupNeeds).toContain('large-files');
  });

  it('names only jobs that exist', () => {
    // A `needs:` entry naming a job that isn't there is a workflow-level error:
    // the whole run fails to start, so no check is reported at all — the same
    // empty-rollup shape #4758 is about, self-inflicted.
    const unknown = rollupNeeds.filter((jobName) => !jobs.has(jobName));
    expect(unknown).toEqual([]);
  });

  it('runs even when the jobs it aggregates were skipped or failed', () => {
    // Without `always()` the roll-up inherits the default `success()` gate and
    // is SKIPPED as soon as one dependency fails. A skipped required check
    // reports as neutral, which GitHub accepts — the failure would merge.
    expect(jobs.get('ci-status')).toContain('    if: always()');
  });

  it('fails on any dependency result other than success or skipped', () => {
    const block = (jobs.get('ci-status') ?? []).join('\n');
    // `skipped` is the only non-success result that passes, and only because a
    // gated job opting out of an irrelevant change set is the design. Anything
    // else — failure, cancelled, or a result GitHub adds later — must fail.
    expect(block).toContain(`select(.value.result != "success" and .value.result != "skipped")`);
    expect(block).toContain('exit 1');
  });
});
