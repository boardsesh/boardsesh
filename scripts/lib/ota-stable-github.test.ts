/// <reference types="node" />

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createStableGithubClient,
  parseTrustedArtifact,
  parseTrustedRun,
  SOURCE_WORKFLOW,
  STABLE_WORKFLOW,
} from './ota-stable-github';

const repository = 'boardsesh/boardsesh';
const headSha = 'a'.repeat(40);
const nowMs = Date.parse('2026-10-09T00:00:00Z');
const runInput = (runId: number, workflow = STABLE_WORKFLOW, overrides: Record<string, unknown> = {}) => ({
  id: runId,
  run_attempt: 1,
  path: workflow,
  head_branch: 'main',
  head_sha: headSha,
  repository: { full_name: repository },
  head_repository: { full_name: repository },
  event: workflow === SOURCE_WORKFLOW ? 'push' : 'schedule',
  status: 'completed',
  conclusion: 'success',
  display_title: 'OTA stable tick',
  ...overrides,
});
const artifactInput = (runId: number, name: string, overrides: Record<string, unknown> = {}) => ({
  id: runId * 10,
  name,
  expired: false,
  expires_at: '2026-11-09T00:00:00Z',
  size_in_bytes: 100,
  workflow_run: { id: runId, head_sha: headSha, head_branch: 'main' },
  ...overrides,
});

function mockClient(responses: Record<string, unknown>) {
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const requestUrl = input instanceof Request ? input.url : input;
    const request = new URL(requestUrl);
    const pathname = request.pathname;
    const matched = Object.entries(responses).find(([suffix]) =>
      suffix.includes('?') ? `${pathname}${request.search}`.endsWith(suffix) : pathname.endsWith(suffix),
    );
    if (!matched) throw new Error(`Unexpected API request: ${pathname}`);
    return new Response(JSON.stringify(matched[1]));
  });
  return {
    client: createStableGithubClient({ repository, token: 'test-token', fetchImpl, nowMs: () => nowMs }),
    fetchImpl,
  };
}

afterEach(() => vi.useRealTimers());

describe('trusted workflow and artifact provenance', () => {
  it('accepts only main push source runs and controlled stable commands', () => {
    expect(parseTrustedRun(runInput(12, SOURCE_WORKFLOW), repository, SOURCE_WORKFLOW)).toMatchObject({
      runId: 12,
      headSha,
      command: null,
    });
    for (const command of ['prepare', 'tick', 'plan', 'qualify', 'abort']) {
      expect(
        parseTrustedRun(
          runInput(12, STABLE_WORKFLOW, { display_title: `OTA stable ${command}` }),
          repository,
          STABLE_WORKFLOW,
        ).command,
      ).toBe(command);
    }
  });

  it.each([
    { path: '.github/workflows/evil.yml' },
    { head_branch: 'feature' },
    { event: 'pull_request' },
    { head_sha: 'main' },
    { id: '1; echo injected' },
    { head_repository: { full_name: 'attacker/boardsesh' } },
    { repository: { full_name: 'other/repo' } },
    { display_title: 'OTA stable tick ; injected' },
    { status: undefined },
  ])('refuses tampered stable run metadata: %j', (overrides) => {
    expect(() => parseTrustedRun(runInput(12, STABLE_WORKFLOW, overrides), repository, STABLE_WORKFLOW)).toThrow();
  });

  it.each([
    { expired: true },
    { expires_at: '2026-10-08T00:00:00Z' },
    { expires_at: 'invalid' },
    { workflow_run: { id: 11, head_sha: headSha, head_branch: 'main' } },
    { workflow_run: { id: 12, head_sha: 'b'.repeat(40), head_branch: 'main' } },
    { workflow_run: { id: 12, head_sha: headSha, head_branch: 'feature' } },
    { workflow_run: null },
    { size_in_bytes: 0 },
    { id: -1 },
  ])('refuses expired or unrelated artifacts: %j', (overrides) => {
    const run = parseTrustedRun(runInput(12), repository, STABLE_WORKFLOW);
    expect(() =>
      parseTrustedArtifact(
        artifactInput(12, 'mobile-ota-stable-state', overrides),
        run,
        'mobile-ota-stable-state',
        nowMs,
      ),
    ).toThrow();
  });
});

const jobInput = (runId: number, name: string, steps: string[] = [], overrides: Record<string, unknown> = {}) => ({
  id: runId * 100 + ['resolve', 'prepare', 'qualify', 'tick', 'smokes', 'boot'].indexOf(name),
  run_id: runId,
  run_attempt: 1,
  head_sha: headSha,
  run_url: `https://api.github.com/repos/${repository}/actions/runs/${runId}`,
  name,
  status: 'completed',
  conclusion: steps.length === 0 ? 'skipped' : name === 'resolve' ? 'success' : 'failure',
  steps: steps.map((name, index) => ({
    name,
    number: index + 1,
    status: 'completed',
    conclusion: [
      'Freeze the exact archived bytes',
      'Record blocking QA verdict',
      'Judge and apply at most one timed step',
    ].includes(name)
      ? 'skipped'
      : name.startsWith('Restore trusted checkpoint') || name === 'Retain final checkpoint even when QA fails'
        ? 'failure'
        : 'success',
  })),
  ...overrides,
});

function failedJobs(runId: number, command = 'tick') {
  return ['resolve', 'prepare', 'qualify', 'tick', 'smokes', 'boot'].map((name) => {
    const commonSteps = [
      'Set up job',
      'Run actions/checkout@' + 'a'.repeat(40),
      'Run actions/setup-node@' + 'b'.repeat(40),
    ];
    if (name === 'resolve') return jobInput(runId, name, ['Set up job', 'Resolve command', 'Complete job']);
    if (command === 'prepare' && name === 'prepare')
      return jobInput(runId, name, [
        ...commonSteps,
        'Restore trusted checkpoint and source deployment',
        'Freeze the exact archived bytes',
        'Retain preparation checkpoint',
        'Retain frozen candidate',
        'Complete job',
      ]);
    if (command === 'prepare' && name === 'qualify')
      return jobInput(runId, name, [
        ...commonSteps,
        'Run actions/download-artifact@' + 'c'.repeat(40),
        'Run actions/download-artifact@' + 'c'.repeat(40),
        'Record blocking QA verdict',
        'Retain final checkpoint even when QA fails',
        'Complete job',
      ]);
    if (command !== 'prepare' && name === 'tick')
      return jobInput(runId, name, [
        ...commonSteps,
        'Restore trusted checkpoint and its exact candidate',
        'Judge and apply at most one timed step',
        'Collect durable upload leases',
        'Retain checkpoint and upload leases',
        'Post Run actions/setup-node@' + 'b'.repeat(40),
        'Post Run actions/checkout@' + 'a'.repeat(40),
        'Complete job',
      ]);
    return jobInput(runId, name);
  });
}

describe('missing checkpoint recovery', () => {
  it('bootstraps through the complete prepare/tick failure chain back to an empty startup failure', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { client } = mockClient({
      'mobile-ota-stable-release.yml/runs': {
        workflow_runs: [
          runInput(14, STABLE_WORKFLOW, { conclusion: 'failure' }),
          runInput(13, STABLE_WORKFLOW, { conclusion: 'failure', display_title: 'OTA stable prepare' }),
          runInput(12, STABLE_WORKFLOW, { conclusion: 'startup_failure' }),
        ],
      },
      'runs/14/artifacts': { artifacts: [] },
      'runs/13/artifacts': { artifacts: [] },
      'runs/12/artifacts': { artifacts: [] },
      'runs/14/attempts/1/jobs': { total_count: 6, jobs: failedJobs(14) },
      'runs/13/attempts/1/jobs': { total_count: 6, jobs: failedJobs(13, 'prepare') },
      'runs/12/attempts/1/jobs': { total_count: 0, jobs: [] },
    });
    await expect(client.latestCheckpoint(15)).resolves.toBeNull();
    expect(stderr.mock.calls.map(([message]) => String(message))).toEqual([
      expect.stringContaining('run 14'),
      expect.stringContaining('run 13'),
      expect.stringContaining('run 12'),
    ]);
    stderr.mockRestore();
  });

  it('restores older durable state after proven pre-write failures', async () => {
    const { client } = mockClient({
      'mobile-ota-stable-release.yml/runs': {
        workflow_runs: [runInput(14, STABLE_WORKFLOW, { conclusion: 'failure' }), runInput(13)],
      },
      'runs/14/artifacts': { artifacts: [] },
      'runs/14/attempts/1/jobs': { total_count: 6, jobs: failedJobs(14) },
      'runs/13/artifacts': { artifacts: [artifactInput(13, 'mobile-ota-stable-state')] },
    });
    await expect(client.latestCheckpoint(15)).resolves.toMatchObject({ runId: 13 });
  });

  it.each([
    { command: 'tick', omittedJobs: ['smokes', 'boot'] },
    { command: 'prepare', omittedJobs: ['smokes', 'boot'] },
    { command: 'tick', omittedJobs: ['smokes'] },
    { command: 'prepare', omittedJobs: ['boot'] },
  ])(
    'recovers $command failures without skipped reusable placeholders $omittedJobs',
    async ({ command, omittedJobs }) => {
      const jobs = failedJobs(14, command).filter((job) => !omittedJobs.includes(job.name));
      const { client } = mockClient({
        'mobile-ota-stable-release.yml/runs': {
          workflow_runs: [
            runInput(14, STABLE_WORKFLOW, { conclusion: 'failure', display_title: `OTA stable ${command}` }),
            runInput(13),
          ],
        },
        'runs/14/artifacts': { artifacts: [] },
        'runs/14/attempts/1/jobs': { total_count: jobs.length, jobs },
        'runs/13/artifacts': { artifacts: [artifactInput(13, 'mobile-ota-stable-state')] },
      });
      await expect(client.latestCheckpoint(15)).resolves.toMatchObject({ runId: 13 });
    },
  );

  it.each(['resolve', 'prepare', 'qualify', 'tick'])(
    'holds without positive evidence for direct job %s even when reusable placeholders are absent',
    async (missingJob) => {
      const jobs = failedJobs(14).filter((job) => ![missingJob, 'smokes', 'boot'].includes(job.name));
      const { client } = mockClient({
        'mobile-ota-stable-release.yml/runs': {
          workflow_runs: [runInput(14, STABLE_WORKFLOW, { conclusion: 'failure' })],
        },
        'runs/14/artifacts': { artifacts: [] },
        'runs/14/attempts/1/jobs': { total_count: jobs.length, jobs },
      });
      await expect(client.latestCheckpoint(15)).rejects.toThrow('has no state artifact');
    },
  );

  it.each([
    [
      'started writer',
      (jobs: ReturnType<typeof failedJobs>) => {
        jobs[3].steps[4].conclusion = 'success';
      },
    ],
    [
      'missing controller step',
      (jobs: ReturnType<typeof failedJobs>) => {
        jobs[3].steps.splice(4, 1);
      },
    ],
    [
      'unknown step',
      (jobs: ReturnType<typeof failedJobs>) => {
        jobs[3].steps[0].name = 'New writer';
      },
    ],
    [
      'wrong run',
      (jobs: ReturnType<typeof failedJobs>) => {
        jobs[3].run_id = 13;
      },
    ],
    [
      'wrong attempt',
      (jobs: ReturnType<typeof failedJobs>) => {
        jobs[3].run_attempt = 2;
      },
    ],
    [
      'wrong SHA',
      (jobs: ReturnType<typeof failedJobs>) => {
        jobs[3].head_sha = 'c'.repeat(40);
      },
    ],
    [
      'wrong URL',
      (jobs: ReturnType<typeof failedJobs>) => {
        jobs[3].run_url = 'https://api.github.com/repos/attacker/repo/actions/runs/14';
      },
    ],
    [
      'unfinished job',
      (jobs: ReturnType<typeof failedJobs>) => {
        jobs[3].status = 'in_progress';
      },
    ],
    [
      'missing job',
      (jobs: ReturnType<typeof failedJobs>) => {
        jobs.splice(1, 1);
      },
    ],
    [
      'duplicate job',
      (jobs: ReturnType<typeof failedJobs>) => {
        jobs[5] = jobs[4];
      },
    ],
    [
      'duplicate step',
      (jobs: ReturnType<typeof failedJobs>) => {
        jobs[3].steps[1].number = 1;
      },
    ],
    [
      'unknown job',
      (jobs: ReturnType<typeof failedJobs>) => {
        jobs[5].name = 'new-writer';
      },
    ],
    [
      'nested reusable job',
      (jobs: ReturnType<typeof failedJobs>) => {
        jobs[5].name = 'boot / resolve';
      },
    ],
    [
      'executed reusable caller',
      (jobs: ReturnType<typeof failedJobs>) => {
        jobs[4].conclusion = 'success';
      },
    ],
  ])('holds after %s', async (_label, mutate) => {
    const jobs = failedJobs(14);
    mutate(jobs);
    const { client } = mockClient({
      'mobile-ota-stable-release.yml/runs': {
        workflow_runs: [runInput(14, STABLE_WORKFLOW, { conclusion: 'failure' }), runInput(13)],
      },
      'runs/14/artifacts': { artifacts: [] },
      'runs/14/attempts/1/jobs': { total_count: jobs.length, jobs },
    });
    await expect(client.latestCheckpoint(15)).rejects.toThrow('has no state artifact');
  });

  it.each(['failure', 'cancelled', 'timed_out'])('holds zero-job %s runs', async (conclusion) => {
    const { client } = mockClient({
      'mobile-ota-stable-release.yml/runs': { workflow_runs: [runInput(14, STABLE_WORKFLOW, { conclusion })] },
      'runs/14/artifacts': { artifacts: [] },
      'runs/14/attempts/1/jobs': { total_count: 0, jobs: [] },
    });
    await expect(client.latestCheckpoint(15)).rejects.toThrow('has no state artifact');
  });

  it.each([undefined, 0, 2])('holds missing or repeated run attempt %s', async (run_attempt) => {
    const { client } = mockClient({
      'mobile-ota-stable-release.yml/runs': {
        workflow_runs: [runInput(14, STABLE_WORKFLOW, { run_attempt, conclusion: 'startup_failure' })],
      },
      'runs/14/artifacts': { artifacts: [] },
    });
    await expect(client.latestCheckpoint(15)).rejects.toThrow();
  });

  it('reads every attempt jobs page before refusing unknown evidence', async () => {
    const { client, fetchImpl } = mockClient({
      'mobile-ota-stable-release.yml/runs': {
        workflow_runs: [runInput(14, STABLE_WORKFLOW, { conclusion: 'failure' })],
      },
      'runs/14/artifacts': { artifacts: [] },
      'runs/14/attempts/1/jobs?per_page=100&page=1': {
        total_count: 101,
        jobs: Array.from({ length: 100 }, (_, index) => jobInput(14, 'unknown', [], { id: index + 1 })),
      },
      'runs/14/attempts/1/jobs?per_page=100&page=2': { total_count: 101, jobs: [jobInput(14, 'tick')] },
    });
    await expect(client.latestCheckpoint(15)).rejects.toThrow('has no state artifact');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it.each([
    { jobs: [] },
    { total_count: 6, jobs: failedJobs(14).slice(0, 5) },
    { total_count: 5, jobs: failedJobs(14) },
  ])('holds incomplete job pagination %j', async (response) => {
    const { client } = mockClient({
      'mobile-ota-stable-release.yml/runs': {
        workflow_runs: [runInput(14, STABLE_WORKFLOW, { conclusion: 'failure' })],
      },
      'runs/14/artifacts': { artifacts: [] },
      'runs/14/attempts/1/jobs': response,
    });
    await expect(client.latestCheckpoint(15)).rejects.toThrow(/pagination|incomplete|reported total/);
  });
});

describe('newest eligible artifact selection', () => {
  it('pins a successful main deployment and validates its staged artifact provenance', async () => {
    const { client } = mockClient({
      'actions/runs/14': runInput(14, SOURCE_WORKFLOW),
      'runs/14/artifacts': { artifacts: [artifactInput(14, 'mobile-ota-stage')] },
    });
    await expect(client.source(14)).resolves.toEqual({ runId: 14, headSha, artifactId: 140 });
  });

  it.each([
    { id: 13 },
    { event: 'workflow_dispatch' },
    { head_branch: 'feature' },
    { conclusion: 'failure' },
    { status: 'in_progress', conclusion: null },
    { head_repository: { full_name: 'attacker/repo' } },
  ])('refuses an untrusted pinned source %j', async (overrides) => {
    const { client } = mockClient({ 'actions/runs/14': runInput(14, SOURCE_WORKFLOW, overrides) });
    await expect(client.source(14)).rejects.toThrow();
  });

  it.each([
    { artifacts: [] },
    { artifacts: [artifactInput(14, 'mobile-ota-stage', { expired: true })] },
    { artifacts: [artifactInput(13, 'mobile-ota-stage')] },
  ])('refuses missing, expired, or unrelated pinned stage artifacts %j', async ({ artifacts }) => {
    const { client } = mockClient({
      'actions/runs/14': runInput(14, SOURCE_WORKFLOW),
      'runs/14/artifacts': { artifacts },
    });
    await expect(client.source(14)).rejects.toThrow();
  });

  it('ignores queued future runs and the current run while restoring the latest older checkpoint', async () => {
    const { client, fetchImpl } = mockClient({
      'mobile-ota-stable-release.yml/runs': {
        workflow_runs: [
          runInput(19, STABLE_WORKFLOW, { status: 'requested', conclusion: null }),
          runInput(18, STABLE_WORKFLOW, { status: 'waiting', conclusion: null }),
          runInput(17, STABLE_WORKFLOW, { status: 'pending', conclusion: null }),
          runInput(16, STABLE_WORKFLOW, { status: 'queued', conclusion: null, display_title: 'OTA stable prepare' }),
          runInput(15, STABLE_WORKFLOW, { status: 'in_progress', conclusion: null }),
          runInput(14),
        ],
      },
      'runs/14/artifacts': { artifacts: [artifactInput(14, 'mobile-ota-stable-state')] },
    });
    await expect(client.latestCheckpoint(15)).resolves.toMatchObject({ runId: 14 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each(['completed', 'in_progress', 'unknown', ''])(
    'holds instead of loading older state behind a future %s writer',
    async (status) => {
      const { client, fetchImpl } = mockClient({
        'mobile-ota-stable-release.yml/runs': {
          workflow_runs: [runInput(16, STABLE_WORKFLOW, { status }), runInput(14)],
        },
        'runs/14/artifacts': { artifacts: [artifactInput(14, 'mobile-ota-stable-state')] },
      });
      await expect(client.latestCheckpoint(15)).rejects.toThrow('Newer stable write run 16');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it('does not silently ignore future writers with missing status metadata', async () => {
    const { client, fetchImpl } = mockClient({
      'mobile-ota-stable-release.yml/runs': {
        workflow_runs: [runInput(16, STABLE_WORKFLOW, { status: undefined }), runInput(14)],
      },
    });
    await expect(client.latestCheckpoint(15)).rejects.toThrow('invalid status');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('ignores a completed future read-only plan because it cannot replace state', async () => {
    const { client } = mockClient({
      'mobile-ota-stable-release.yml/runs': {
        workflow_runs: [runInput(16, STABLE_WORKFLOW, { display_title: 'OTA stable plan' }), runInput(14)],
      },
      'runs/14/artifacts': { artifacts: [artifactInput(14, 'mobile-ota-stable-state')] },
    });
    await expect(client.latestCheckpoint(15)).resolves.toMatchObject({ runId: 14 });
  });

  it.each([0, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'refuses an invalid current run boundary %s',
    async (excludeRunId) => {
      const { client, fetchImpl } = mockClient({});
      await expect(client.latestCheckpoint(excludeRunId)).rejects.toThrow('positive safe integer');
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('uses the latest abort checkpoint rather than resurrecting a previous active canary', async () => {
    const { client, fetchImpl } = mockClient({
      'mobile-ota-stable-release.yml/runs': {
        workflow_runs: [runInput(14, STABLE_WORKFLOW, { display_title: 'OTA stable abort' }), runInput(13)],
      },
      'runs/14/artifacts': { artifacts: [artifactInput(14, 'mobile-ota-stable-state')] },
    });
    await expect(client.latestCheckpoint(15)).resolves.toMatchObject({ runId: 14 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('holds after an abort whose latest state artifact is missing', async () => {
    const { client, fetchImpl } = mockClient({
      'mobile-ota-stable-release.yml/runs': {
        workflow_runs: [
          runInput(14, STABLE_WORKFLOW, { display_title: 'OTA stable abort', conclusion: 'failure' }),
          runInput(13),
        ],
      },
      'runs/14/artifacts': { artifacts: [] },
      'runs/14/attempts/1/jobs': { total_count: 0, jobs: [] },
    });
    await expect(client.latestCheckpoint(15)).rejects.toThrow('has no state artifact');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('skips failed and non-OTA deployments, returning the latest complete stage', async () => {
    const { client } = mockClient({
      'production-deploy.yml/runs': {
        workflow_runs: [
          runInput(15, SOURCE_WORKFLOW, { conclusion: 'failure' }),
          runInput(14, SOURCE_WORKFLOW),
          runInput(13, SOURCE_WORKFLOW),
        ],
      },
      'runs/14/artifacts': { artifacts: [] },
      'runs/13/artifacts': { artifacts: [artifactInput(13, 'mobile-ota-stage')] },
    });
    await expect(client.latestSource()).resolves.toEqual({ runId: 13, headSha, artifactId: 130 });
  });

  it('never falls back to older staged bytes when the newest stage expired', async () => {
    const { client, fetchImpl } = mockClient({
      'production-deploy.yml/runs': { workflow_runs: [runInput(14, SOURCE_WORKFLOW), runInput(13, SOURCE_WORKFLOW)] },
      'runs/14/artifacts': { artifacts: [artifactInput(14, 'mobile-ota-stage', { expired: true })] },
    });
    await expect(client.latestSource()).rejects.toThrow('expired');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('ignores the current run and read-only plans but accepts the latest failed checkpoint', async () => {
    const { client } = mockClient({
      'mobile-ota-stable-release.yml/runs': {
        workflow_runs: [
          runInput(15),
          runInput(14, STABLE_WORKFLOW, { display_title: 'OTA stable plan' }),
          runInput(13, STABLE_WORKFLOW, { conclusion: 'failure' }),
        ],
      },
      'runs/13/artifacts': { artifacts: [artifactInput(13, 'mobile-ota-stable-state')] },
    });
    await expect(client.latestCheckpoint(15)).resolves.toMatchObject({ runId: 13 });
  });

  it('bootstraps only when no earlier write-mode runs exist', async () => {
    const { client } = mockClient({
      'mobile-ota-stable-release.yml/runs': {
        workflow_runs: [runInput(15), runInput(14, STABLE_WORKFLOW, { display_title: 'OTA stable plan' })],
      },
    });
    await expect(client.latestCheckpoint(15)).resolves.toBeNull();
  });

  it.each(['failure', 'cancelled', 'timed_out', 'success'])(
    'holds on the latest %s run missing state, without using an older checkpoint',
    async (conclusion) => {
      const { client, fetchImpl } = mockClient({
        'mobile-ota-stable-release.yml/runs': {
          workflow_runs: [runInput(14, STABLE_WORKFLOW, { conclusion }), runInput(13)],
        },
        'runs/14/artifacts': { artifacts: [] },
        'runs/14/attempts/1/jobs': { total_count: 0, jobs: [] },
      });
      await expect(client.latestCheckpoint(15)).rejects.toThrow('has no state artifact');
      expect(fetchImpl).toHaveBeenCalledTimes(conclusion === 'success' ? 2 : 3);
    },
  );

  it('holds when an earlier controller is still running or its state expired', async () => {
    const running = mockClient({
      'mobile-ota-stable-release.yml/runs': {
        workflow_runs: [runInput(14, STABLE_WORKFLOW, { status: 'in_progress', conclusion: null })],
      },
    });
    await expect(running.client.latestCheckpoint(15)).rejects.toThrow('still in_progress');
    const expired = mockClient({
      'mobile-ota-stable-release.yml/runs': { workflow_runs: [runInput(14)] },
      'runs/14/artifacts': { artifacts: [artifactInput(14, 'mobile-ota-stable-state', { expired: true })] },
    });
    await expect(expired.client.latestCheckpoint(15)).rejects.toThrow('expired');
  });

  it.each([
    { display_title: 'OTA stable tick' },
    { conclusion: 'failure' },
    { event: 'push' },
    { status: 'in_progress', conclusion: null },
    { head_branch: 'feature' },
  ])('refuses candidates outside successful trusted prepare runs: %j', async (overrides) => {
    const { client } = mockClient({
      'actions/runs/14': runInput(14, STABLE_WORKFLOW, { display_title: 'OTA stable prepare', ...overrides }),
    });
    await expect(client.candidate(14)).rejects.toThrow();
  });

  it('accepts the named candidate only from its successful preparation run', async () => {
    const { client } = mockClient({
      'actions/runs/14': runInput(14, STABLE_WORKFLOW, { display_title: 'OTA stable prepare' }),
      'runs/14/artifacts': { artifacts: [artifactInput(14, 'mobile-ota-stable-candidate')] },
    });
    await expect(client.candidate(14)).resolves.toEqual({ runId: 14, headSha, artifactId: 140 });
  });
});

describe('bounded GitHub reads', () => {
  it('does not forward its token to the signed storage redirect', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) =>
      init?.headers
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://storage.example/archive.zip?signature=secret' },
          })
        : new Response(new Uint8Array([80, 75])),
    );
    const client = createStableGithubClient({ repository, token: 'test-token', fetchImpl });
    await expect(client.downloadArtifact(14)).resolves.toEqual(new Uint8Array([80, 75]));
    expect(fetchImpl.mock.calls[0][1]?.headers).toHaveProperty('Authorization', 'Bearer test-token');
    expect(fetchImpl.mock.calls[1][1]?.headers).toBeUndefined();
    expect(fetchImpl.mock.calls[1][1]?.redirect).toBe('error');
  });

  it('times out a stalled JSON body as well as the initial API request', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
            },
          }),
        ),
    );
    const client = createStableGithubClient({ repository, token: 'test-token', fetchImpl });
    const pending = expect(client.latestSource()).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });
});
