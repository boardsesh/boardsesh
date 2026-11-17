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
  env?: Record<string, string>;
};
type Workflow = {
  on: { workflow_run?: { workflows: string[]; types: string[] } };
  permissions: Record<string, string>;
  concurrency?: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, { if?: string; needs?: string[]; 'runs-on': string; steps: WorkflowStep[] }>;
};
const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as Workflow;
const publisher = parse(readFileSync('.github/workflows/publish-test-reports.yml', 'utf8')) as Workflow;
const { parseStringPromise } = require('xml2js') as {
  parseStringPromise: (xml: string) => Promise<{
    testsuites: { $: { tests: string; failures: string; errors: string }; testsuite?: unknown[] };
  }>;
};

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
  const context = { repo: { owner: 'boardsesh', repo: 'boardsesh' }, runId: 456, payload: { workflow_run: run } };
  const core = {
    notice: vi.fn(),
    setOutput: vi.fn((key: string, output: string | number | boolean) => outputs.set(key, output)),
  };
  const github = {
    rest: {
      repos: { listPullRequestsAssociatedWithCommit: 'associated' },
      actions: { listWorkflowRunArtifacts: 'artifacts' },
      pulls: { get: vi.fn(async () => ({ data: pullRequest })) },
      checks: {
        create: vi.fn(async (input: { head_sha: string; status: string; conclusion: string }) => ({
          data: { head_sha: input.head_sha, status: input.status, conclusion: input.conclusion },
        })),
        update: vi.fn(),
      },
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
    expect(publisherStep('Parse CI test results').with?.['fail-on-error']).toBe('false');
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
    const report = publisherStep('Parse CI test results');
    expect(report.with?.path).toBe('${{ runner.temp }}/ci-test-results/**/*.xml');
    expect(report.if).toBe("steps.current.outputs.publish == 'true'");
    expect(publisher.jobs.publish.steps.some((step) => step.run !== undefined)).toBe(false);
  });
});

describe('completed test report publication', () => {
  function reports(passed = '10', failed = '0', skipped = '2') {
    vi.stubEnv('PR_NUMBER', '6255');
    vi.stubEnv('REPORT_OUTCOME', 'success');
    vi.stubEnv('REPORT_CONCLUSION', Number(failed) > 0 ? 'failure' : 'success');
    vi.stubEnv('REPORT_PASSED', passed);
    vi.stubEnv('REPORT_FAILED', failed);
    vi.stubEnv('REPORT_SKIPPED', skipped);
    return fixture();
  }

  it.each(['0', '3'])('creates one completed check with %s failures and actual counts', async (failed) => {
    const inputs = reports('10', failed, '2');
    await executeScript('publish', inputs);
    expect(inputs.github.rest.checks.create).toHaveBeenCalledExactlyOnceWith({
      owner: 'boardsesh',
      repo: 'boardsesh',
      name: 'CI Tests Report',
      head_sha: 'tested-head',
      status: 'completed',
      conclusion: failed === '0' ? 'success' : 'failure',
      details_url: 'https://github.com/boardsesh/boardsesh/actions/runs/456',
      output: {
        title: `10 passed, ${failed} failed, 2 skipped.`,
        summary: `10 passed, ${failed} failed, 2 skipped.\n\n[Full test report](https://github.com/boardsesh/boardsesh/actions/runs/456).`,
      },
    });
    expect(inputs.github.rest.checks.update).not.toHaveBeenCalled();
    expect(inputs.outputs.get('message')).toContain(`10 passed, ${failed} failed, 2 skipped.`);
  });

  it('accepts a report containing only skipped tests without inventing passes', async () => {
    const inputs = reports('0', '0', '4');
    await executeScript('publish', inputs);
    expect(inputs.outputs.get('message')).toContain('0 passed, 0 failed, 4 skipped.');
  });

  it.each(['', '-1', '1.5', 'NaN', '1e2', '1000000001', '9007199254740992'])(
    'rejects missing or malformed JUnit counts: %s',
    async (count) => {
      const inputs = reports(count);
      await expect(executeScript('publish', inputs)).rejects.toThrow(/JUnit count/);
      expect(inputs.github.rest.pulls.get).not.toHaveBeenCalled();
      expect(inputs.github.rest.checks.create).not.toHaveBeenCalled();
    },
  );

  it('reports the actual empty Vitest XML as neutral without inventing passing tests', async () => {
    // Exact XML from both changed-file shards in CI run 43947606632.
    const xml = readFileSync('scripts/__tests__/fixtures/ci-report-zero-tests.xml', 'utf8');
    const { testsuites } = await parseStringPromise(xml);
    expect(testsuites.$).toMatchObject({ tests: '0', failures: '0', errors: '0' });
    expect(testsuites.testsuite).toBeUndefined();
    const inputs = reports('0', '0', '0');
    await executeScript('publish', inputs);
    expect(inputs.github.rest.checks.create).toHaveBeenCalledExactlyOnceWith({
      owner: 'boardsesh',
      repo: 'boardsesh',
      name: 'CI Tests Report',
      head_sha: 'tested-head',
      status: 'completed',
      conclusion: 'neutral',
      details_url: 'https://github.com/boardsesh/boardsesh/actions/runs/456',
      output: {
        title: 'No tests ran. 0 passed, 0 failed, 0 skipped.',
        summary:
          'No tests ran. 0 passed, 0 failed, 0 skipped.\n\n[Full test report](https://github.com/boardsesh/boardsesh/actions/runs/456).',
      },
    });
    expect(inputs.github.rest.checks.update).not.toHaveBeenCalled();
    expect(inputs.outputs.get('message')).toContain('No tests ran. 0 passed, 0 failed, 0 skipped.');
  });

  it.each(['failure', 'timed_out', 'cancelled', 'skipped', 'neutral', ''])(
    'rejects zero tests from %s source CI',
    async (conclusion) => {
      const inputs = reports('0', '0', '0');
      inputs.run.conclusion = conclusion;
      await expect(executeScript('publish', inputs)).rejects.toThrow('requires successful source CI');
      expect(inputs.github.rest.pulls.get).not.toHaveBeenCalled();
      expect(inputs.github.rest.checks.create).not.toHaveBeenCalled();
    },
  );

  it.each(['failure', 'neutral', ''])('rejects a zero-test parser conclusion of %s', async (conclusion) => {
    const inputs = reports('0', '0', '0');
    vi.stubEnv('REPORT_CONCLUSION', conclusion);
    await expect(executeScript('publish', inputs)).rejects.toThrow('conclusion/count mismatch');
    expect(inputs.github.rest.checks.create).not.toHaveBeenCalled();
  });

  it('does not turn malformed XML into a neutral report', async () => {
    const inputs = reports('0', '0', '0');
    await expect(parseStringPromise('<testsuites><broken></testsuites>')).rejects.toThrow();
    vi.stubEnv('REPORT_OUTCOME', 'failure');
    await expect(executeScript('publish', inputs)).rejects.toThrow('parsing did not succeed');
    expect(inputs.github.rest.checks.create).not.toHaveBeenCalled();
  });

  it.each(['failure', 'skipped', 'cancelled'])('cannot publish after parser outcome %s', async (outcome) => {
    const inputs = reports();
    vi.stubEnv('REPORT_OUTCOME', outcome);
    await expect(executeScript('publish', inputs)).rejects.toThrow('parsing did not succeed');
    expect(inputs.github.rest.checks.create).not.toHaveBeenCalled();
  });

  it.each(['', 'success', 'neutral'])('rejects a conclusion inconsistent with failures: %s', async (conclusion) => {
    const inputs = reports('4', '1', '0');
    vi.stubEnv('REPORT_CONCLUSION', conclusion);
    await expect(executeScript('publish', inputs)).rejects.toThrow('conclusion/count mismatch');
    expect(inputs.github.rest.checks.create).not.toHaveBeenCalled();
  });

  it.each(['closed', 'advanced', 'other repository', 'other branch', 'other base'])(
    'skips a PR that became %s while parsing reports',
    async (state) => {
      const inputs = reports();
      if (state === 'closed') inputs.pullRequest.state = 'closed';
      if (state === 'advanced') inputs.pullRequest.head.sha = 'new-head';
      if (state === 'other repository') inputs.pullRequest.head.repo.full_name = 'other/boardsesh';
      if (state === 'other branch') inputs.pullRequest.head.ref = 'other';
      if (state === 'other base') inputs.pullRequest.base.repo.full_name = 'other/boardsesh';
      await executeScript('publish', inputs);
      expect(inputs.github.rest.checks.create).not.toHaveBeenCalled();
      expect(inputs.outputs.size).toBe(0);
    },
  );

  it('propagates GitHub create failure without a fabricated conclusion or PATCH', async () => {
    const inputs = reports();
    inputs.github.rest.checks.create.mockRejectedValueOnce(new Error('Not Found'));
    await expect(executeScript('publish', inputs)).rejects.toThrow('Not Found');
    expect(inputs.github.rest.checks.create).toHaveBeenCalledTimes(1);
    expect(inputs.github.rest.checks.update).not.toHaveBeenCalled();
    expect(inputs.outputs.size).toBe(0);
  });

  it('keeps zero-test GitHub errors as failures instead of inventing a passing check', async () => {
    const inputs = reports('0', '0', '0');
    inputs.github.rest.checks.create.mockRejectedValueOnce(new Error('Forbidden'));
    await expect(executeScript('publish', inputs)).rejects.toThrow('Forbidden');
    expect(inputs.github.rest.checks.create).toHaveBeenCalledTimes(1);
    expect(inputs.github.rest.checks.create.mock.calls[0][0].conclusion).toBe('neutral');
    expect(inputs.github.rest.checks.update).not.toHaveBeenCalled();
    expect(inputs.outputs.size).toBe(0);
  });

  it('skips a superseded zero-test report before creating a neutral check', async () => {
    const inputs = reports('0', '0', '0');
    inputs.pullRequest.head.sha = 'new-head';
    await executeScript('publish', inputs);
    expect(inputs.github.rest.checks.create).not.toHaveBeenCalled();
    expect(inputs.outputs.size).toBe(0);
  });

  it('requires GitHub to confirm the actual completed check before commenting', async () => {
    const inputs = reports();
    inputs.github.rest.checks.create.mockResolvedValueOnce({
      data: { head_sha: 'tested-head', status: 'in_progress', conclusion: '' },
    });
    await expect(executeScript('publish', inputs)).rejects.toThrow('did not confirm');
    expect(inputs.outputs.size).toBe(0);
  });

  it('parses trusted XML into a job summary and uses only its validated outputs', () => {
    const parse = publisherStep('report');
    expect(parse.uses).toBe('phoenix-actions/test-reporting@f957cd93fc2d848d556fa0d03c57bc79127b6b5e');
    expect(parse.with?.reporter).toBe('java-junit');
    expect(parse.with?.['output-to']).toBe('step-summary');
    expect(parse['continue-on-error']).toBeUndefined();
    expect(publisherStep('publish').env).toEqual({
      PR_NUMBER: '${{ steps.inspect.outputs.pr-number }}',
      REPORT_OUTCOME: '${{ steps.report.outcome }}',
      REPORT_CONCLUSION: '${{ steps.report.outputs.conclusion }}',
      REPORT_PASSED: '${{ steps.report.outputs.passed }}',
      REPORT_FAILED: '${{ steps.report.outputs.failed }}',
      REPORT_SKIPPED: '${{ steps.report.outputs.skipped }}',
    });
    expect(publisherStep('publish').if).toBe("steps.current.outputs.publish == 'true'");
    expect(publisherStep('Report publication failure').if).toBe("failure() && steps.current.outputs.publish == 'true'");
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

  it.each([
    'test-default',
    'test-backend',
    'test-auth-compatibility',
    'test-auth-mirror',
    'test-ocr',
    'test-location-sync-integration',
  ])('still blocks ci-status when %s fails', (failedJob) => {
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
  });
});
