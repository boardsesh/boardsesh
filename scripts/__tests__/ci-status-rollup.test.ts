/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

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

type WorkflowStep = { id?: string; if?: string; run?: string; 'continue-on-error'?: boolean | string };
type WorkflowJob = { needs?: string | string[]; if?: string; steps?: WorkflowStep[] };
type Workflow = { jobs: Record<string, WorkflowJob> };

function conditionExpression(condition?: string): string {
  return (condition ?? '')
    .trim()
    .replace(/^\$\{\{|\}\}$/g, '')
    .replace(/'(?:[^']|'')*'|\s+/g, (fragment) => (fragment.startsWith("'") ? fragment : ''));
}

/** Job dependencies support YAML block lists, inline lists, and a single job. */
function jobNeeds(jobName: string, source = workflowSource): string[] {
  const workflow = parse(source) as Workflow;
  const job = workflow.jobs[jobName];
  if (!job) throw new Error(`ci.yml has no \`${jobName}\` job`);
  const needs = job.needs;
  return typeof needs === 'string' ? [needs] : (needs ?? []);
}

describe('reading workflow dependencies', () => {
  it.each([
    ['block list', 'needs:\n      - lint\n      - guards', ['lint', 'guards']],
    ['inline list', 'needs: [lint, guards]', ['lint', 'guards']],
    ['single job', 'needs: guards', ['guards']],
  ])('reads a %s', (_format, declaration, expected) => {
    expect(jobNeeds('ci-status', `jobs:\n  ci-status:\n    ${declaration}\n`)).toEqual(expected);
  });
});

describe('ci-status is a complete roll-up', () => {
  const rollupNeeds = jobNeeds('ci-status');

  it('depends on every gating job in the workflow', () => {
    const missing = [...jobs.keys()].filter((jobName) => jobName !== 'ci-status' && !rollupNeeds.includes(jobName));

    expect(
      missing,
      'These jobs can fail while `ci-status` stays green, and `ci-status` is the required check — ' +
        'add them to its `needs:` so failures cannot disappear from the required result.',
    ).toEqual([]);
  });

  it('keeps the ungated large-files step in the required guards job', () => {
    // Main consolidated the standalone gate into guards. A binary-only PR must
    // still run it, and a failed check must still fail the required roll-up.
    expect(rollupNeeds).toContain('guards');
    const guards = (parse(workflowSource) as Workflow).jobs.guards;
    expect(conditionExpression(guards.if)).toBe('!cancelled()');
    const largeFilesStep = guards.steps?.find((step) => step.id === 'large-files');
    expect(largeFilesStep).toBeDefined();
    expect(largeFilesStep?.run).toContain('scripts/check-large-files.mjs');
    expect(conditionExpression(largeFilesStep?.if)).toBe("!cancelled()&&steps.install.outcome=='success'");
    expect(largeFilesStep?.['continue-on-error'] ?? false).toBe(false);
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
