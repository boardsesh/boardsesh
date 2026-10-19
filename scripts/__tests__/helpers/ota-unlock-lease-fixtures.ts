import { createUnlockLeaseGuard } from '../../lib/ota-unlock-lease.mjs';
import type { UnlockCaller, UnlockCallerLease } from '../../lib/ota-unlock-lease.mjs';

export const callerRepository = 'boardsesh/boardsesh';
export const callerRequestId = '01234567-0123-4567-89ab-0123456789ab';
export const unlockCaller: UnlockCaller = {
  workflowPath: '.github/workflows/mobile-ota-production.yml',
  headBranch: 'main',
  runId: 15,
  runAttempt: 1,
  headSha: 'a'.repeat(40),
  jobKey: 'publish',
  runnerName: 'test-runner',
};

export function callerLeaseFixture() {
  const lease: UnlockCallerLease = {
    ...unlockCaller,
    version: 1,
    repository: callerRepository,
    requestId: callerRequestId,
    issuedAtMs: 1_000_000,
    expiresAtMs: 2_200_000,
    jobId: 51,
    stepNumber: 7,
    stepName: 'Await trusted main unlock before direct production publish',
    branch: 'production',
    runtimes: { ios: 'a'.repeat(40), android: 'b'.repeat(40) },
  };
  const run = {
    id: lease.runId,
    run_attempt: lease.runAttempt,
    head_sha: lease.headSha,
    head_branch: lease.headBranch,
    path: lease.workflowPath,
    repository: { full_name: callerRepository },
    head_repository: { full_name: callerRepository },
    event: 'workflow_dispatch',
    status: 'in_progress',
    conclusion: null as string | null,
  };
  const job = {
    id: lease.jobId,
    run_id: lease.runId,
    run_attempt: lease.runAttempt,
    head_sha: lease.headSha,
    run_url: `https://api.github.com/repos/${callerRepository}/actions/runs/${lease.runId}`,
    runner_name: lease.runnerName,
    name: 'publish',
    status: 'in_progress',
    conclusion: null as string | null,
    steps: [
      { number: lease.stepNumber, name: lease.stepName, status: 'in_progress', conclusion: null as string | null },
    ],
  };
  const calls: string[] = [];
  const clock = { nowMs: lease.issuedAtMs, afterRead: undefined as ((path: string) => void) | undefined };
  const fetchImpl: typeof fetch = async (input) => {
    const href = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
    calls.push(href);
    clock.afterRead?.(href);
    return Response.json(href.includes('/actions/jobs/') ? job : run);
  };
  const guardOptions = () => ({
    requestId: callerRequestId,
    serializedLease: JSON.stringify(lease),
    repository: callerRepository,
    token: 'token',
    branch: lease.branch,
    iosRuntime: lease.runtimes.ios,
    androidRuntime: lease.runtimes.android,
  });
  const guard = (target?: { branch: string; runtimeVersion: string }) =>
    createUnlockLeaseGuard(guardOptions(), { now: () => clock.nowMs, fetchImpl })(target);
  return { lease, run, job, calls, clock, fetchImpl, guard, guardOptions };
}
