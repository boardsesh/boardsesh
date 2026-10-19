import { describe, expect, it, vi } from 'vitest';
import {
  createUnlockLeaseGuard,
  discoverUnlockCallerLease,
  protectUnlockWrites,
  unlockCallerFromEnvironment,
} from './ota-unlock-lease.mjs';
import {
  callerLeaseFixture,
  callerRepository,
  callerRequestId,
  unlockCaller,
} from '../__tests__/helpers/ota-unlock-lease-fixtures';
type Revert = (branch: string, runtime: string, expectedId: string | number) => Promise<void>;

describe('automatic unlock caller lease', () => {
  it('never writes an automatic request without its lease', async () => {
    const client = { revertUpdateRollout: vi.fn<Revert>(async () => {}) };
    const attempt = async () => {
      const guard = createUnlockLeaseGuard({ requestId: callerRequestId });
      await protectUnlockWrites(client, guard).revertUpdateRollout('production', unlockCaller.headSha, 11);
    };
    await expect(attempt()).rejects.toThrow('requires its bounded caller lease');
    expect(client.revertUpdateRollout).not.toHaveBeenCalled();
  });
  it('preserves exactly empty manual requests and never falls back from an automatic lease', async () => {
    await expect(createUnlockLeaseGuard({})()).resolves.toBeUndefined();
    for (const options of [
      { requestId: callerRequestId },
      { serializedLease: '{}' },
      { requestId: callerRequestId, serializedLease: '{}' },
      { requestId: callerRequestId, serializedLease: 'invalid-json' },
    ])
      expect(() => createUnlockLeaseGuard(options)).toThrow();
  });
  it('binds the exact same-repository active run, attempt, head, job and wait step', async () => {
    const { guard, calls } = callerLeaseFixture();
    await guard();
    expect(calls).toEqual([
      'https://api.github.com/repos/boardsesh/boardsesh/actions/runs/15',
      'https://api.github.com/repos/boardsesh/boardsesh/actions/jobs/51',
    ]);
  });
  it('rejects invalid identities, unbounded deadlines and mismatched request targets', async () => {
    for (const change of [
      { runId: 0 },
      { jobId: 0 },
      { stepNumber: 0 },
      { runAttempt: -1 },
      { repository: 'foreign/repo' },
      { requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      { expiresAtMs: 9_000_000 },
      { expiresAtMs: Number.NaN },
      { issuedAtMs: -1 },
      { branch: 'other' },
      { runtimes: { ios: 'c'.repeat(40), android: 'b'.repeat(40) } },
    ]) {
      const fixture = callerLeaseFixture();
      expect(() =>
        createUnlockLeaseGuard({
          ...fixture.guardOptions(),
          serializedLease: JSON.stringify({ ...fixture.lease, ...change }),
        }),
      ).toThrow();
    }
    const fixture = callerLeaseFixture();
    const client = { revertUpdateRollout: vi.fn<Revert>(async () => {}) };
    const protectedClient = protectUnlockWrites(client, fixture.guard);
    await expect(protectedClient.revertUpdateRollout('other', fixture.lease.runtimes.ios, 11)).rejects.toThrow(
      'outside',
    );
    await expect(protectedClient.revertUpdateRollout('production', 'c'.repeat(40), 11)).rejects.toThrow('outside');
    fixture.lease.runtimes.android = '';
    await expect(protectedClient.revertUpdateRollout('production', '', 11)).rejects.toThrow('outside');
    expect(client.revertUpdateRollout).not.toHaveBeenCalled();
  });
  it.each([
    'cancelled',
    'run-completed',
    'foreign-repository',
    'foreign-head-repository',
    'wrong-attempt',
    'wrong-head',
    'wrong-workflow',
    'wrong-job',
    'wrong-job-attempt',
    'wrong-job-run',
    'wrong-job-head',
    'wrong-runner',
    'wrong-job-name',
    'job-completed',
    'step-completed',
    'wrong-step-number',
    'duplicate-step',
    'multiple-active-steps',
  ])('refuses %s before a protected write', async (failure) => {
    const fixture = callerLeaseFixture();
    const { run, job } = fixture;
    if (failure === 'cancelled') run.status = 'cancelled';
    if (failure === 'run-completed') run.status = 'completed';
    if (failure === 'foreign-repository') run.repository.full_name = 'foreign/repo';
    if (failure === 'foreign-head-repository') run.head_repository.full_name = 'foreign/repo';
    if (failure === 'wrong-attempt') run.run_attempt = 2;
    if (failure === 'wrong-head') run.head_sha = 'b'.repeat(40);
    if (failure === 'wrong-workflow') run.path = '.github/workflows/other.yml';
    if (failure === 'wrong-job') job.id++;
    if (failure === 'wrong-job-attempt') job.run_attempt = 2;
    if (failure === 'wrong-job-run') job.run_id++;
    if (failure === 'wrong-job-head') job.head_sha = 'b'.repeat(40);
    if (failure === 'wrong-runner') job.runner_name = 'other-runner';
    if (failure === 'wrong-job-name') job.name = 'another-job';
    if (failure === 'job-completed') job.status = 'completed';
    if (failure === 'step-completed') job.steps[0].status = 'completed';
    if (failure === 'wrong-step-number') job.steps[0].number++;
    if (failure === 'duplicate-step') job.steps.push({ ...job.steps[0], number: 8, status: 'completed' });
    if (failure === 'multiple-active-steps') job.steps.push({ ...job.steps[0], name: 'another-step', number: 8 });
    const client = { revertUpdateRollout: vi.fn<Revert>(async () => {}) };
    await expect(
      protectUnlockWrites(client, fixture.guard).revertUpdateRollout('production', unlockCaller.headSha, 11),
    ).rejects.toThrow();
    expect(client.revertUpdateRollout).not.toHaveBeenCalled();
  });
  it.each(['expired', 'headroom', 'expires-during-read', 'api-failure'])(
    'refuses %s without a write',
    async (failure) => {
      const fixture = callerLeaseFixture();
      if (failure === 'expired') fixture.clock.nowMs = fixture.lease.expiresAtMs;
      if (failure === 'headroom') fixture.clock.nowMs = fixture.lease.expiresAtMs - 30_000;
      if (failure === 'expires-during-read')
        fixture.clock.afterRead = (path) => {
          if (path.includes('/actions/jobs/')) fixture.clock.nowMs = fixture.lease.expiresAtMs;
        };
      const guard =
        failure === 'api-failure'
          ? createUnlockLeaseGuard(fixture.guardOptions(), {
              now: () => fixture.clock.nowMs,
              fetchImpl: async () => new Response('', { status: 503 }),
            })
          : fixture.guard;
      const client = { revertUpdateRollout: vi.fn<Revert>(async () => {}) };
      await expect(
        protectUnlockWrites(client, guard).revertUpdateRollout('production', unlockCaller.headSha, 11),
      ).rejects.toThrow();
      expect(client.revertUpdateRollout).not.toHaveBeenCalled();
    },
  );
  it('retains the selected compare-and-swap ID when a rollout changes during the lease read', async () => {
    const fixture = callerLeaseFixture();
    let currentId = 11;
    fixture.clock.afterRead = () => {
      currentId = 99;
    };
    const client = {
      revertUpdateRollout: vi.fn(async (_branch: string, _runtime: string, expectedId: string | number) => {
        if (expectedId !== currentId) throw new Error('expected update changed');
      }),
    };
    await expect(
      protectUnlockWrites(client, fixture.guard).revertUpdateRollout('production', unlockCaller.headSha, 11),
    ).rejects.toThrow('expected update changed');
    expect(client.revertUpdateRollout).toHaveBeenCalledWith('production', unlockCaller.headSha, 11);
  });
  it.each(['step-ended', 'expired'])('rechecks lifetime between ordinary writes when caller %s', async (failure) => {
    const fixture = callerLeaseFixture();
    const client = {
      revertUpdateRollout: vi.fn<Revert>(async () => {
        if (failure === 'expired') fixture.clock.nowMs = fixture.lease.expiresAtMs;
        else fixture.job.steps[0].status = 'completed';
      }),
    };
    const protectedClient = protectUnlockWrites(client, fixture.guard);
    await protectedClient.revertUpdateRollout('production', fixture.lease.runtimes.ios, 11);
    await expect(protectedClient.revertUpdateRollout('production', fixture.lease.runtimes.android, 21)).rejects.toThrow(
      /wait step|expired/,
    );
    expect(client.revertUpdateRollout).toHaveBeenCalledTimes(1);
  });
});

describe('caller discovery before dispatch', () => {
  function discoveryFixture() {
    const fixture = callerLeaseFixture();
    const listing = { total_count: 1, jobs: [fixture.job] };
    const api = vi.fn(async (path: string): Promise<unknown> => (path.includes('/jobs?') ? listing : fixture.run));
    const run = () =>
      discoverUnlockCallerLease(
        {
          caller: unlockCaller,
          repository: callerRepository,
          requestId: callerRequestId,
          issuedAtMs: fixture.lease.issuedAtMs,
          expiresAtMs: fixture.lease.expiresAtMs,
          branch: fixture.lease.branch,
          iosRuntime: fixture.lease.runtimes.ios,
          androidRuntime: fixture.lease.runtimes.android,
        },
        { api, now: () => fixture.clock.nowMs, sleep: async () => {} },
      );
    return { ...fixture, listing, api, discover: run };
  }
  it('discovers the exact numeric job and step after bounded visibility polling', async () => {
    const fixture = discoveryFixture();
    fixture.api.mockResolvedValueOnce(fixture.run).mockResolvedValueOnce({ total_count: 0, jobs: [] });
    expect(await fixture.discover()).toEqual(fixture.lease);
    expect(fixture.api).toHaveBeenCalledTimes(4);
  });
  it.each(['ambiguous', 'missing', 'incomplete', 'duplicate-id', 'foreign-entry'])(
    'refuses %s job listings',
    async (failure) => {
      const fixture = discoveryFixture();
      if (failure === 'ambiguous') fixture.listing.jobs.push({ ...fixture.job, id: 52 });
      if (failure === 'missing') fixture.listing.jobs = [];
      if (failure === 'duplicate-id') fixture.listing.jobs.push({ ...fixture.job });
      if (failure === 'foreign-entry') fixture.listing.jobs.push({ ...fixture.job, id: 52, run_id: 99 });
      fixture.listing.total_count = fixture.listing.jobs.length;
      if (failure === 'incomplete') fixture.listing.total_count = 2;
      await expect(fixture.discover()).rejects.toThrow();
    },
  );
  it('reads the complete paginated attempt before deciding uniqueness', async () => {
    const fixture = discoveryFixture();
    const first = Array.from({ length: 100 }, (_, index) => ({ ...fixture.job, id: index + 100, status: 'completed' }));
    fixture.api
      .mockResolvedValueOnce(fixture.run)
      .mockResolvedValueOnce({ total_count: 101, jobs: first })
      .mockResolvedValueOnce({ total_count: 101, jobs: [fixture.job] });
    expect(await fixture.discover()).toEqual(fixture.lease);
    expect(fixture.api.mock.calls[2][0]).toContain('page=2');
  });
  it('never accepts a first-page match without checking remaining jobs', async () => {
    const fixture = discoveryFixture();
    const firstPage = [
      fixture.job,
      ...Array.from({ length: 99 }, (_, index) => ({ ...fixture.job, id: index + 100, status: 'completed' })),
    ];
    fixture.api
      .mockResolvedValueOnce(fixture.run)
      .mockResolvedValueOnce({ total_count: 101, jobs: firstPage })
      .mockResolvedValueOnce({ total_count: 101, jobs: [{ ...fixture.job, id: 52 }] });
    await expect(fixture.discover()).rejects.toThrow('Multiple active jobs');
  });
  it('preserves production main/release callers and both backport matrix job names', async () => {
    for (const [path, branch, jobKey] of [
      ['mobile-ota-production.yml', 'main', 'publish'],
      ['mobile-ota-production.yml', 'release/next', 'publish'],
      ['mobile-ota-promote-staged.yml', 'main', 'promote'],
      ['mobile-ota-backport.yml', 'main', 'backport'],
    ]) {
      expect(
        unlockCallerFromEnvironment(
          {
            GITHUB_WORKFLOW_REF: `${callerRepository}/.github/workflows/${path}@refs/heads/${branch}`,
            GITHUB_RUN_ID: '15',
            GITHUB_RUN_ATTEMPT: '1',
            GITHUB_SHA: unlockCaller.headSha,
            GITHUB_JOB: jobKey,
            RUNNER_NAME: 'runner',
          },
          callerRepository,
        ),
      ).toMatchObject({ headBranch: branch, jobKey });
    }
    for (const platform of ['ios', 'android']) {
      const fixture = callerLeaseFixture();
      fixture.lease.workflowPath = '.github/workflows/mobile-ota-backport.yml';
      fixture.lease.jobKey = 'backport';
      fixture.lease.stepName = 'Await trusted main unlock before the backport publish';
      fixture.run.path = fixture.lease.workflowPath;
      fixture.job.name = `backport (${platform})`;
      fixture.job.steps[0].name = fixture.lease.stepName;
      await fixture.guard();
      const otherJob = {
        ...fixture.job,
        id: 52,
        name: `backport (${platform === 'ios' ? 'android' : 'ios'})`,
        status: 'queued',
      };
      const api = async (path: string) =>
        path.includes('/jobs?') ? { total_count: 2, jobs: [fixture.job, otherJob] } : fixture.run;
      const discover = () =>
        discoverUnlockCallerLease(
          {
            caller: fixture.lease,
            repository: callerRepository,
            requestId: callerRequestId,
            issuedAtMs: fixture.lease.issuedAtMs,
            expiresAtMs: fixture.lease.expiresAtMs,
            branch: fixture.lease.branch,
            iosRuntime: fixture.lease.runtimes.ios,
            androidRuntime: fixture.lease.runtimes.android,
          },
          { api, now: () => fixture.clock.nowMs, sleep: async () => {} },
        );
      expect((await discover()).jobId).toBe(51);
      otherJob.status = 'in_progress';
      await expect(discover()).rejects.toThrow('Multiple active jobs');
    }
  });
});
