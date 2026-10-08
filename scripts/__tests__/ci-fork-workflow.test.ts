/// <reference types="node" />

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { categorize } from '../lib/changelog-transform';

type WorkflowStep = {
  name?: string;
  id?: string;
  uses?: string;
  if?: string;
  run?: string;
  'continue-on-error'?: boolean;
  with?: Record<string, string | boolean>;
};
type Workflow = {
  on: { workflow_run?: { workflows: string[]; types: string[] } };
  permissions: Record<string, string>;
  concurrency?: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, { if?: string; needs?: string[]; 'runs-on': string; steps: WorkflowStep[] }>;
};
const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as Workflow;
const publisher = parse(readFileSync('.github/workflows/publish-test-reports.yml', 'utf8')) as Workflow;

function publisherStep(idOrName: string): WorkflowStep {
  const step = publisher.jobs.publish.steps.find((entry) => entry.id === idOrName || entry.name === idOrName);
  if (!step) throw new Error(`Missing publisher step ${idOrName}`);
  return step;
}

function fixture(headRepository = 'contributor/boardsesh') {
  const run = {
    id: 123,
    event: 'pull_request',
    conclusion: 'success',
    repository: { full_name: 'boardsesh/boardsesh' },
    head_repository: { full_name: headRepository },
    head_branch: 'fix/contribution',
    head_sha: 'tested-head',
    head_commit: { id: 'tested-head' },
    pull_requests: [],
  };
  const pullRequest = {
    number: 6255,
    state: 'open',
    base: { repo: { full_name: 'boardsesh/boardsesh' } },
    head: { repo: { full_name: headRepository }, ref: 'fix/contribution', sha: 'tested-head' },
  };
  const associated = [pullRequest];
  const artifacts = [{ name: 'test-results-default-1', expired: false }];
  const outputs = new Map<string, string | number | boolean>();
  const context = { repo: { owner: 'boardsesh', repo: 'boardsesh' }, payload: { workflow_run: run } };
  const core = {
    notice: vi.fn(),
    setOutput: vi.fn((key: string, output: string | number | boolean) => outputs.set(key, output)),
  };
  const github = {
    rest: {
      repos: { listPullRequestsAssociatedWithCommit: 'associated' },
      actions: { listWorkflowRunArtifacts: 'artifacts' },
      pulls: { get: vi.fn(async () => ({ data: pullRequest })) },
    },
    paginate: vi.fn(async (endpoint: string) => (endpoint === 'associated' ? associated : artifacts)),
  };
  return { run, pullRequest, associated, artifacts, context, core, github, outputs };
}

async function executeScript(id: string, inputs: ReturnType<typeof fixture>): Promise<void> {
  const script = publisherStep(id).with?.script;
  if (typeof script !== 'string') throw new Error(`No script for ${id}`);
  // Execute the actual workflow code against GitHub mocks, so regressions in
  // its fork lookup and stale-head predicates change these results.
  // oxlint-disable-next-line no-implied-eval
  const execute = new Function('github', 'context', 'core', `return (async () => {${script}\n})();`) as (
    github: unknown,
    context: unknown,
    core: unknown,
  ) => Promise<void>;
  await execute(inputs.github, inputs.context, inputs.core);
}

afterEach(() => vi.unstubAllEnvs());

describe('fork-safe CI reporting', () => {
  it.each(['contributor/boardsesh', 'boardsesh/boardsesh'])(
    'resolves %s with no PR in the event payload',
    async (repository) => {
      const inputs = fixture(repository);
      await executeScript('inspect', inputs);
      expect(inputs.outputs.get('pr-number')).toBe(6255);
      expect(inputs.github.paginate).toHaveBeenCalledWith('associated', {
        owner: 'boardsesh',
        repo: 'boardsesh',
        commit_sha: 'tested-head',
        per_page: 100,
      });
      expect(inputs.github.paginate).toHaveBeenCalledWith('artifacts', {
        owner: 'boardsesh',
        repo: 'boardsesh',
        run_id: 123,
        per_page: 100,
      });
    },
  );

  it('publishes results even when CI failed', async () => {
    const inputs = fixture();
    inputs.run.conclusion = 'failure';
    await executeScript('inspect', inputs);
    expect(inputs.outputs.get('pr-number')).toBe(6255);
    expect(publisher.jobs.publish.if).not.toContain("conclusion == 'success'");
    expect(publisherStep('Publish CI test results').with?.['comment-message-success']).toContain('{2} failed');
  });

  it.each(['sha', 'ref', 'repository', 'closed', 'base'])('rejects a PR with mismatched %s', async (mismatch) => {
    const inputs = fixture();
    if (mismatch === 'sha') inputs.pullRequest.head.sha = 'new-head';
    if (mismatch === 'ref') inputs.pullRequest.head.ref = 'other-branch';
    if (mismatch === 'repository') inputs.pullRequest.head.repo.full_name = 'other/boardsesh';
    if (mismatch === 'closed') inputs.pullRequest.state = 'closed';
    if (mismatch === 'base') inputs.pullRequest.base.repo.full_name = 'other/boardsesh';
    await executeScript('inspect', inputs);
    expect(inputs.outputs.size).toBe(0);
    expect(inputs.github.paginate).toHaveBeenCalledTimes(1);
  });

  it.each(['none', 'ambiguous'])('does not guess when matching PRs are %s', async (matching) => {
    const inputs = fixture();
    if (matching === 'none') inputs.associated.length = 0;
    else inputs.associated.push({ ...inputs.pullRequest, number: 6256 });
    await executeScript('inspect', inputs);
    expect(inputs.outputs.size).toBe(0);
  });

  it.each(['foreign repository', 'different report commit'])('rejects %s before querying GitHub', async (mismatch) => {
    const inputs = fixture();
    if (mismatch === 'foreign repository') inputs.run.repository.full_name = 'other/boardsesh';
    else inputs.run.head_commit.id = 'other-commit';
    await executeScript('inspect', inputs);
    expect(inputs.outputs.size).toBe(0);
    expect(inputs.github.paginate).not.toHaveBeenCalled();
  });

  it.each(['absent', 'unrelated', 'expired'])('skips %s test artifacts', async (artifactCase) => {
    const inputs = fixture();
    if (artifactCase === 'absent') inputs.artifacts.length = 0;
    if (artifactCase === 'unrelated') inputs.artifacts[0].name = 'build-output';
    if (artifactCase === 'expired') inputs.artifacts[0].expired = true;
    await executeScript('inspect', inputs);
    expect(inputs.outputs.size).toBe(0);
  });

  it.each(['open', 'closed', 'advanced', 'other repository', 'other branch'])(
    'rechecks the %s PR after downloading',
    async (state) => {
      const inputs = fixture();
      vi.stubEnv('PR_NUMBER', '6255');
      if (state === 'closed') inputs.pullRequest.state = 'closed';
      if (state === 'advanced') inputs.pullRequest.head.sha = 'new-head';
      if (state === 'other repository') inputs.pullRequest.head.repo.full_name = 'other/boardsesh';
      if (state === 'other branch') inputs.pullRequest.head.ref = 'other-branch';
      await executeScript('current', inputs);
      expect(inputs.outputs.get('publish')).toBe(state === 'open');
      expect(inputs.github.rest.pulls.get).toHaveBeenCalledWith({
        owner: 'boardsesh',
        repo: 'boardsesh',
        pull_number: 6255,
      });
    },
  );

  it('runs only after PR CI and skips canceled runs', () => {
    expect(publisher.on.workflow_run).toEqual({ workflows: ['CI'], types: ['completed'] });
    expect(publisher.jobs.publish.if).toBe(
      "github.event.workflow_run.event == 'pull_request' && github.event.workflow_run.conclusion != 'cancelled'",
    );
    expect(publisher.jobs.publish['runs-on']).toBe('ubuntu-latest');
    expect(publisher.permissions).toEqual({
      actions: 'read',
      contents: 'read',
      checks: 'write',
      'pull-requests': 'write',
    });
    expect(ci.permissions).toEqual({ contents: 'read', 'pull-requests': 'read', packages: 'read' });
    expect(ci.jobs['test-report']).toBeUndefined();
  });

  it('serializes same-head reports without an older head canceling a newer publisher', () => {
    expect(publisher.concurrency?.group).toContain('${{ github.event.workflow_run.head_sha }}');
    expect(publisher.concurrency?.['cancel-in-progress']).toBe(false);
  });

  it('checks out trusted code and isolates downloaded XML from the checkout', () => {
    const checkout = publisher.jobs.publish.steps.find((step) => step.uses === 'actions/checkout@v6');
    expect(checkout?.with).toEqual({ ref: '${{ github.sha }}', 'persist-credentials': false });
    const download = publisherStep('Download all test results from CI');
    expect(download.with?.['run-id']).toBe('${{ github.event.workflow_run.id }}');
    expect(download.with?.path).toBe('${{ runner.temp }}/ci-test-results');
    expect(download.with?.pattern).toBe('test-results-*');
    const report = publisherStep('Publish CI test results');
    expect(report.with?.['comment-message-pr-number']).toBe('${{ steps.inspect.outputs.pr-number }}');
    expect(report.with?.['report-path']).toBe('${{ runner.temp }}/ci-test-results/**/*.xml');
    expect(report.if).toBe("steps.current.outputs.publish == 'true'");
    expect(publisher.jobs.publish.steps.some((step) => step.run !== undefined)).toBe(false);
  });
});

describe('CI contribution gates', () => {
  it('accepts free-form PR titles and keeps commit checks advisory', () => {
    expect(ci.jobs.guards.steps.some((step) => step.run?.includes('--pr-title'))).toBe(false);
    const advisoryChecks = ci.jobs.guards.steps.filter((step) => step.name?.startsWith('commit-lint'));
    expect(advisoryChecks).toHaveLength(2);
    for (const check of advisoryChecks) {
      expect(check['continue-on-error']).toBe(true);
      expect(check.id).toBeUndefined();
    }
    expect(categorize('Fix warm-up length near the lowest grades')).toBe('improved');
  });

  it.each(['test-default', 'test-backend', 'test-ocr', 'test-location-sync-integration'])(
    'still blocks ci-status when %s fails',
    (failedJob) => {
      const status = ci.jobs['ci-status'];
      expect(status.needs).toContain(failedJob);
      const run = status.steps[0].run;
      if (!run) throw new Error('No ci-status shell');
      const results = Object.fromEntries(
        (status.needs ?? []).map((job) => [job, { result: job === failedJob ? 'failure' : 'success' }]),
      );
      const execution = spawnSync('bash', ['-c', run], {
        encoding: 'utf8',
        env: { ...process.env, RESULTS: JSON.stringify(results) },
      });
      expect(execution.status).toBe(1);
      expect(execution.stdout).toContain(`${failedJob}: failure`);
    },
  );
});
