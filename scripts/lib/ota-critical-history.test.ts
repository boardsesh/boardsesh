import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { latestConsumedCriticalRelease } from './ota-critical-history';
import type { CriticalReleaseHistoryOptions } from './ota-critical-history';
import { SOURCE_WORKFLOW } from './ota-stable-github';

const repository = 'boardsesh/boardsesh';
const commit = (index: number) => index.toString(16).padStart(40, '0');
const run = (runId: number, head = 15, overrides: Record<string, unknown> = {}) => ({
  id: runId,
  run_attempt: 1,
  path: SOURCE_WORKFLOW,
  head_branch: 'main',
  head_sha: commit(head),
  repository: { full_name: repository },
  head_repository: { full_name: repository },
  event: 'push',
  status: 'completed',
  conclusion: 'failure',
  ...overrides,
});
const promotion = (runId: number, head = 15, overrides: Record<string, unknown> = {}) => ({
  id: runId * 100,
  run_id: runId,
  run_attempt: 1,
  head_sha: commit(head),
  run_url: `https://api.github.com/repos/${repository}/actions/runs/${runId}`,
  name: 'promote-mobile-ota',
  status: 'completed',
  conclusion: 'failure',
  steps: [{ name: 'Release critical staged bytes to 100% stable', status: 'completed', conclusion: 'success' }],
  ...overrides,
});
const listing = (runs: unknown[]) => ({ workflow_runs: runs });
const jobListing = (jobs: unknown[]) => ({ total_count: jobs.length, jobs });
const workflowPath = 'production-deploy.yml/runs?branch=main&per_page=100&page=1';

function fixture(responses: Record<string, unknown>) {
  const github = vi.fn(async (endpoint: string) => {
    const response = Object.entries(responses).find(([suffix]) => endpoint.endsWith(suffix));
    if (!response) throw new Error(`Unexpected history request: ${endpoint}`);
    return response[1];
  });
  const git = vi.fn((argumentsList: string[]) => {
    expect(argumentsList[0]).toBe('merge-base');
    expect(argumentsList).toHaveLength(3);
    return Number.parseInt(argumentsList[1], 16) <= Number.parseInt(argumentsList[2], 16)
      ? argumentsList[1]
      : argumentsList[2];
  });
  const options: CriticalReleaseHistoryOptions = {
    repository,
    currentRunId: '30',
    headSha: commit(20),
    deploymentBaseSha: commit(10),
    github,
    git,
  };
  return { options, github, git };
}

describe('critical publication consumption boundary', () => {
  it('recognizes the actual production workflow promotion job and critical step names', async () => {
    const workflow = parse(readFileSync(resolve(import.meta.dirname, '../../', SOURCE_WORKFLOW), 'utf8')) as {
      jobs: Record<string, { name?: string; steps: { id?: string; name?: string }[] }>;
    };
    const job = workflow.jobs['promote-mobile-ota'];
    const criticalStep = job.steps.find((step) => step.id === 'critical-promote');
    expect(criticalStep?.name).toBeDefined();
    const test = fixture({
      [workflowPath]: listing([run(25)]),
      'runs/25/attempts/1/jobs?per_page=100&page=1': jobListing([
        promotion(25, 15, {
          name: job.name ?? 'promote-mobile-ota',
          steps: [{ name: criticalStep?.name, status: 'completed', conclusion: 'success' }],
        }),
      ]),
    });
    await expect(latestConsumedCriticalRelease(test.options)).resolves.toBe(commit(15));
  });

  it.each(['failure', 'cancelled', 'success'])(
    'consumes a successful critical step when the overall deployment is %s',
    async (conclusion) => {
      const test = fixture({
        [workflowPath]: listing([run(25, 15, { conclusion })]),
        'runs/25/attempts/1/jobs?per_page=100&page=1': jobListing([promotion(25)]),
      });
      await expect(latestConsumedCriticalRelease(test.options)).resolves.toBe(commit(15));
    },
  );

  it('accepts a trusted manual production recovery and its first attempt after a rerun', async () => {
    const test = fixture({
      [workflowPath]: listing([run(25, 15, { event: 'workflow_dispatch', run_attempt: 2 })]),
      'runs/25/attempts/1/jobs?per_page=100&page=1': jobListing([promotion(25)]),
    });
    await expect(latestConsumedCriticalRelease(test.options)).resolves.toBe(commit(15));
  });

  it('consumes the same HEAD from an earlier production run', async () => {
    const test = fixture({
      [workflowPath]: listing([run(25, 20)]),
      'runs/25/attempts/1/jobs?per_page=100&page=1': jobListing([promotion(25, 20)]),
    });
    await expect(latestConsumedCriticalRelease(test.options)).resolves.toBe(commit(20));
  });

  it('ignores current and future runs without treating queued successors as publication', async () => {
    const test = fixture({
      [workflowPath]: listing([run(31), run(30), run(25)]),
      'runs/25/attempts/1/jobs?per_page=100&page=1': jobListing([promotion(25)]),
    });
    await expect(latestConsumedCriticalRelease(test.options)).resolves.toBe(commit(15));
    expect(test.github).toHaveBeenCalledTimes(2);
  });

  it('stops at the successful deployment baseline before reading obsolete failed attempts', async () => {
    const test = fixture({ [workflowPath]: listing([run(25, 10), run(24, 9)]) });
    await expect(latestConsumedCriticalRelease(test.options)).resolves.toBeNull();
    expect(test.github).toHaveBeenCalledTimes(1);
  });

  it('preserves consumed intent when an older successful ancestor bounds a full history page', async () => {
    const history = [
      run(199, 15),
      run(198, 10, { conclusion: 'cancelled' }),
      run(197, 9, { conclusion: 'success' }),
      ...Array.from({ length: 97 }, (_, index) => run(196 - index, 8)),
    ];
    const test = fixture({
      [workflowPath]: listing(history),
      'runs/199/attempts/1/jobs?per_page=100&page=1': jobListing([promotion(199, 15)]),
    });
    test.options.currentRunId = '200';
    await expect(latestConsumedCriticalRelease(test.options)).resolves.toBe(commit(15));
    expect(test.github).toHaveBeenCalledTimes(2);
  });

  it('bounds initial history at a proven successful noncritical deployment', async () => {
    const test = fixture({
      [workflowPath]: listing([run(25, 15, { conclusion: 'success' }), run(24, 14)]),
      'runs/25/attempts/1/jobs?per_page=100&page=1': jobListing([
        promotion(25, 15, {
          steps: [{ name: 'Release critical staged bytes to 100% stable', status: 'completed', conclusion: 'skipped' }],
        }),
      ]),
    });
    test.options.deploymentBaseSha = '';
    await expect(latestConsumedCriticalRelease(test.options)).resolves.toBeNull();
    expect(test.github).toHaveBeenCalledTimes(2);
  });

  it('preserves a consumed newer attempt at the initial-history cutoff', async () => {
    const test = fixture({
      [workflowPath]: listing([run(25, 16), run(24, 15, { conclusion: 'success' })]),
      'runs/25/attempts/1/jobs?per_page=100&page=1': jobListing([
        promotion(25, 16, {
          steps: [{ name: 'Release critical staged bytes to 100% stable', status: 'completed', conclusion: 'failure' }],
        }),
      ]),
      'runs/24/attempts/1/jobs?per_page=100&page=1': jobListing([promotion(24, 15, { steps: [] })]),
    });
    test.options.deploymentBaseSha = '';
    await expect(latestConsumedCriticalRelease(test.options)).resolves.toBe(commit(16));
  });

  it.each([
    { steps: [] },
    { conclusion: 'skipped', steps: [] },
    { conclusion: 'skipped', steps: undefined },
    { steps: [{ name: 'Release critical staged bytes to 100% stable', status: 'completed', conclusion: 'skipped' }] },
    {
      status: 'queued',
      conclusion: null,
      steps: [{ name: 'Release critical staged bytes to 100% stable', status: 'queued', conclusion: null }],
    },
  ])('does not consume skipped or unstarted critical publication %#', async (overrides) => {
    const test = fixture({
      [workflowPath]: listing([run(25), run(24, 10)]),
      'runs/25/attempts/1/jobs?per_page=100&page=1': jobListing([promotion(25, 15, overrides)]),
    });
    await expect(latestConsumedCriticalRelease(test.options)).resolves.toBeNull();
  });

  it.each(['failure', 'cancelled', 'timed_out'])(
    'consumes intent after a terminal critical step with conclusion %s',
    async (conclusion) => {
      const test = fixture({
        [workflowPath]: listing([run(25), run(24, 10)]),
        'runs/25/attempts/1/jobs?per_page=100&page=1': jobListing([
          promotion(25, 15, {
            steps: [
              {
                name: 'Release critical staged bytes to 100% stable',
                status: 'completed',
                conclusion,
              },
            ],
          }),
        ]),
      });
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        await expect(latestConsumedCriticalRelease(test.options)).resolves.toBe(commit(15));
        expect(warning).toHaveBeenCalledWith(expect.stringContaining('its authorization'));
      } finally {
        warning.mockRestore();
      }
    },
  );

  it('refuses an unfinished earlier critical writer', async () => {
    const test = fixture({
      [workflowPath]: listing([run(25, 15, { status: 'in_progress', conclusion: null })]),
      'runs/25/attempts/1/jobs?per_page=100&page=1': jobListing([
        promotion(25, 15, {
          status: 'in_progress',
          conclusion: null,
          steps: [{ name: 'Release critical staged bytes to 100% stable', status: 'in_progress', conclusion: null }],
        }),
      ]),
    });
    await expect(latestConsumedCriticalRelease(test.options)).rejects.toThrow(/unfinished or invalid/);
  });

  it('does not block a newer proven critical publication on older partial publication', async () => {
    const test = fixture({
      [workflowPath]: listing([run(25, 16), run(24, 15)]),
      'runs/25/attempts/1/jobs?per_page=100&page=1': jobListing([promotion(25, 16)]),
      'runs/24/attempts/1/jobs?per_page=100&page=1': jobListing([
        promotion(24, 15, {
          steps: [{ name: 'Release critical staged bytes to 100% stable', status: 'completed', conclusion: 'failure' }],
        }),
      ]),
    });
    await expect(latestConsumedCriticalRelease(test.options)).resolves.toBe(commit(16));
    expect(test.github).toHaveBeenCalledTimes(3);
  });

  it('allows a successful newer SHA to cover an ambiguous attempt allocated later', async () => {
    const test = fixture({
      [workflowPath]: listing([run(25, 15), run(24, 16)]),
      'runs/25/attempts/1/jobs?per_page=100&page=1': jobListing([
        promotion(25, 15, {
          steps: [{ name: 'Release critical staged bytes to 100% stable', status: 'completed', conclusion: 'failure' }],
        }),
      ]),
      'runs/24/attempts/1/jobs?per_page=100&page=1': jobListing([promotion(24, 16)]),
    });
    await expect(latestConsumedCriticalRelease(test.options)).resolves.toBe(commit(16));
  });

  it('keeps a consumed later SHA even when an earlier SHA was published successfully', async () => {
    const test = fixture({
      [workflowPath]: listing([run(25, 16), run(24, 15)]),
      'runs/25/attempts/1/jobs?per_page=100&page=1': jobListing([
        promotion(25, 16, {
          steps: [{ name: 'Release critical staged bytes to 100% stable', status: 'completed', conclusion: 'failure' }],
        }),
      ]),
      'runs/24/attempts/1/jobs?per_page=100&page=1': jobListing([promotion(24)]),
    });
    await expect(latestConsumedCriticalRelease(test.options)).resolves.toBe(commit(16));
  });

  it.each([
    [15, 16],
    [16, 15],
  ])('aggregates successful attempts by ancestry despite allocation order %j', async (firstHead, secondHead) => {
    const test = fixture({
      [workflowPath]: listing([run(25, firstHead), run(24, secondHead)]),
      'runs/25/attempts/1/jobs?per_page=100&page=1': jobListing([promotion(25, firstHead)]),
      'runs/24/attempts/1/jobs?per_page=100&page=1': jobListing([promotion(24, secondHead)]),
    });
    await expect(latestConsumedCriticalRelease(test.options)).resolves.toBe(commit(16));
  });

  it('does not consume a publication outside the current main ancestry', async () => {
    const test = fixture({ [workflowPath]: listing([run(25, 21), run(24, 10)]) });
    await expect(latestConsumedCriticalRelease(test.options)).resolves.toBeNull();
    expect(test.github).toHaveBeenCalledTimes(1);
  });

  it.each(['startup_failure', 'cancelled'])(
    'does not invent publication for a completed %s run with no first-attempt jobs',
    async (conclusion) => {
      const test = fixture({
        [workflowPath]: listing([run(25, 15, { conclusion }), run(24, 10)]),
        'runs/25/attempts/1/jobs?per_page=100&page=1': jobListing([]),
      });
      await expect(latestConsumedCriticalRelease(test.options)).resolves.toBeNull();
    },
  );

  it('refuses empty job evidence for a cancellation that has not completed', async () => {
    const test = fixture({
      [workflowPath]: listing([run(25, 15, { status: 'in_progress', conclusion: 'cancelled' })]),
      'runs/25/attempts/1/jobs?per_page=100&page=1': jobListing([]),
    });
    await expect(latestConsumedCriticalRelease(test.options)).rejects.toThrow(/promotion job is missing/);
  });

  it.each([
    { path: '.github/workflows/other.yml' },
    { head_branch: 'feature' },
    { event: 'pull_request' },
    { head_sha: 'main' },
    { repository: { full_name: 'attacker/repo' } },
    { head_repository: { full_name: 'attacker/repo' } },
    { run_attempt: 0 },
    { status: undefined },
    { conclusion: undefined },
  ])('refuses untrusted workflow metadata %#', async (overrides) => {
    const test = fixture({ [workflowPath]: listing([run(25, 15, overrides)]) });
    await expect(latestConsumedCriticalRelease(test.options)).rejects.toThrow();
  });

  it.each([
    { run_id: 24 },
    { run_attempt: 2 },
    { head_sha: commit(16) },
    { run_url: 'https://api.github.com/repos/attacker/repo/actions/runs/25' },
    { name: 'Other promotion' },
    { status: undefined },
    { steps: undefined },
  ])('refuses missing or untrusted promotion metadata %#', async (overrides) => {
    const test = fixture({
      [workflowPath]: listing([run(25)]),
      'runs/25/attempts/1/jobs?per_page=100&page=1': jobListing([promotion(25, 15, overrides)]),
    });
    await expect(latestConsumedCriticalRelease(test.options)).rejects.toThrow();
  });

  it.each([
    { jobs: [promotion(25)] },
    { total_count: 2, jobs: [promotion(25)] },
    { total_count: 0, jobs: [promotion(25)] },
  ])('refuses incomplete job pagination %#', async (response) => {
    const test = fixture({
      [workflowPath]: listing([run(25)]),
      'runs/25/attempts/1/jobs?per_page=100&page=1': response,
    });
    await expect(latestConsumedCriticalRelease(test.options)).rejects.toThrow(/pagination/);
  });

  it('refuses duplicate workflow runs, promotion jobs and critical steps', async () => {
    const repeatedRuns = fixture({
      [workflowPath]: listing([run(25), run(25)]),
      'runs/25/attempts/1/jobs?per_page=100&page=1': jobListing([
        promotion(25, 15, { conclusion: 'skipped', steps: [] }),
      ]),
    });
    await expect(latestConsumedCriticalRelease(repeatedRuns.options)).rejects.toThrow(/Duplicate/);
    const repeatedJobs = fixture({
      [workflowPath]: listing([run(25)]),
      'runs/25/attempts/1/jobs?per_page=100&page=1': jobListing([promotion(25), promotion(25, 15, { id: 2501 })]),
    });
    await expect(latestConsumedCriticalRelease(repeatedJobs.options)).rejects.toThrow(/missing or ambiguous/);
    const repeatedSteps = fixture({
      [workflowPath]: listing([run(25)]),
      'runs/25/attempts/1/jobs?per_page=100&page=1': jobListing([
        promotion(25, 15, { steps: [...promotion(25).steps, ...promotion(25).steps] }),
      ]),
    });
    await expect(latestConsumedCriticalRelease(repeatedSteps.options)).rejects.toThrow(/step evidence is ambiguous/);
  });

  it('reads all jobs pages before trusting a publication', async () => {
    const otherJobs = Array.from({ length: 100 }, (_, index) =>
      promotion(25, 15, { id: index + 1, name: `Other ${index}` }),
    );
    const test = fixture({
      [workflowPath]: listing([run(25)]),
      'runs/25/attempts/1/jobs?per_page=100&page=1': { total_count: 101, jobs: otherJobs },
      'runs/25/attempts/1/jobs?per_page=100&page=2': { total_count: 101, jobs: [promotion(25)] },
    });
    await expect(latestConsumedCriticalRelease(test.options)).resolves.toBe(commit(15));
    expect(test.github).toHaveBeenCalledTimes(3);
  });

  it('fails closed when workflow history reaches the pagination bound', async () => {
    const responses = Object.fromEntries(
      Array.from({ length: 10 }, (_, page) => [
        `production-deploy.yml/runs?branch=main&per_page=100&page=${page + 1}`,
        listing(Array.from({ length: 100 }, (_, index) => run(2000 - page * 100 - index, 21))),
      ]),
    );
    const test = fixture(responses);
    test.options.currentRunId = '3000';
    await expect(latestConsumedCriticalRelease(test.options)).rejects.toThrow(/history was truncated/);
    expect(test.github).toHaveBeenCalledTimes(10);
  });

  it('propagates failed ancestry and API reads rather than replaying unknown intent', async () => {
    const test = fixture({ [workflowPath]: listing([run(25)]) });
    test.git.mockImplementation(() => {
      throw new Error('git unavailable');
    });
    await expect(latestConsumedCriticalRelease(test.options)).rejects.toThrow('git unavailable');
    const unavailable = fixture({});
    await expect(latestConsumedCriticalRelease(unavailable.options)).rejects.toThrow('Unexpected history request');
  });
});
