import { createHash } from 'node:crypto';
import { canonicalJson } from './screenshot-fixtures';

const hash = (bytes: string): string => createHash('sha256').update(bytes).digest('hex');
const id = (candidate: unknown): candidate is number => Number.isSafeInteger(candidate) && Number(candidate) > 0;
function list(candidate: unknown, fail: () => never): Record<string, unknown>[] {
  if (
    !Array.isArray(candidate) ||
    candidate.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))
  )
    return fail();
  return candidate as Record<string, unknown>[];
}

export interface RetainedExecution {
  name: string;
  jobId: number;
  attempt: number;
  conclusion: string;
  startedAt: string;
  completedAt: string;
  signatureSha256: string;
}
export interface RetainedRetryHistory {
  version: 1;
  attempts: Array<{ attempt: number; jobsSha256: string }>;
  selectedExecutions: Array<RetainedExecution & { latestJobId: number }>;
  excludedArtifacts: Array<{
    id: number;
    name: string;
    digest: string;
    createdAt: string;
    jobId: number;
    attempt: number;
  }>;
}

export function retainedExecution(job: Record<string, unknown>, fail: () => never): RetainedExecution {
  const startedAt = job.started_at;
  const completedAt = job.completed_at;
  if (
    typeof job.name !== 'string' ||
    !id(job.id) ||
    !id(job.run_attempt) ||
    typeof startedAt !== 'string' ||
    typeof completedAt !== 'string' ||
    !Number.isFinite(Date.parse(startedAt)) ||
    !Number.isFinite(Date.parse(completedAt)) ||
    Date.parse(startedAt) > Date.parse(completedAt) ||
    !['success', 'failure'].includes(String(job.conclusion))
  )
    return fail();
  const steps = list(job.steps, fail);
  if (!steps.length || new Set(steps.map((step) => step.number)).size !== steps.length) return fail();
  for (const step of steps) {
    if (
      !id(step.number) ||
      typeof step.name !== 'string' ||
      !step.name ||
      step.status !== 'completed' ||
      !(
        job.conclusion === 'success' ? ['success', 'skipped'] : ['success', 'skipped', 'failure', 'cancelled']
      ).includes(String(step.conclusion))
    )
      return fail();
    if (step.conclusion === 'skipped' && step.started_at === null && step.completed_at === null) continue;
    if (
      typeof step.started_at !== 'string' ||
      typeof step.completed_at !== 'string' ||
      !Number.isFinite(Date.parse(step.started_at)) ||
      !Number.isFinite(Date.parse(step.completed_at)) ||
      Date.parse(step.started_at) < Date.parse(startedAt) ||
      Date.parse(step.completed_at) > Date.parse(completedAt) ||
      Date.parse(step.started_at) > Date.parse(step.completed_at)
    )
      return fail();
  }
  if (job.name.startsWith('cpp-capture') && job.conclusion === 'success') {
    const captures = steps.filter((step) => step.name === 'Capture target-specific native scenes');
    if (captures.length !== 1 || captures[0].conclusion !== 'success') return fail();
  }
  // Rerun inventories clone carried successes with new IDs and attempt numbers.
  // Only the exact execution window and ordered step outcomes identify the original job.
  return {
    name: job.name,
    jobId: job.id,
    attempt: job.run_attempt,
    conclusion: String(job.conclusion),
    startedAt,
    completedAt,
    signatureSha256: hash(
      canonicalJson({
        name: job.name,
        headSha: job.head_sha,
        status: job.status,
        conclusion: job.conclusion,
        startedAt,
        completedAt,
        steps: steps.map((step) => ({
          number: step.number,
          name: step.name,
          status: step.status,
          conclusion: step.conclusion,
          startedAt: step.started_at,
          completedAt: step.completed_at,
        })),
      }),
    ),
  };
}

export function retainedHistory(
  prefix: string,
  runId: number,
  attempt: number,
  producerSha: string,
  latestJobs: Record<string, unknown>[],
  client: { pages(path: string, field: string): Record<string, unknown>[] },
  skippedJobs: readonly string[],
  fail: () => never,
): { history: RetainedRetryHistory; executions: RetainedExecution[] } {
  const history: RetainedRetryHistory = { version: 1, attempts: [], selectedExecutions: [], excludedArtifacts: [] };
  const executions = new Map<string, RetainedExecution>();
  const allJobIds = new Set<number>();
  const names = latestJobs.map((job) => String(job.name)).sort();
  if (names.length > 100 || new Set(names).size !== names.length) return fail();
  for (let number = 1; number <= attempt; number++) {
    const jobs =
      number === attempt
        ? latestJobs
        : client.pages(`${prefix}/runs/${runId}/attempts/${number}/jobs?per_page=100`, 'jobs');
    if (canonicalJson(jobs.map((job) => String(job.name)).sort()) !== canonicalJson(names)) return fail();
    for (const job of jobs) {
      if (
        !id(job.id) ||
        allJobIds.has(job.id) ||
        typeof job.name !== 'string' ||
        !job.name ||
        job.run_id !== runId ||
        job.run_attempt !== number ||
        job.head_sha !== producerSha ||
        job.status !== 'completed' ||
        !['success', 'skipped', 'failure'].includes(String(job.conclusion)) ||
        (skippedJobs.includes(String(job.name)) && job.conclusion !== 'skipped')
      )
        return fail();
      allJobIds.add(job.id);
      if (job.conclusion !== 'skipped') {
        const actual = retainedExecution(job, fail);
        // Earlier matching records retain the real execution ID; later clones add no new execution.
        if (!executions.has(actual.signatureSha256)) executions.set(actual.signatureSha256, actual);
      }
    }
    history.attempts.push({
      attempt: number,
      jobsSha256: hash(
        canonicalJson(
          [...jobs]
            .sort((left, right) => (String(left.name) < String(right.name) ? -1 : 1))
            .map((job) => ({
              id: job.id,
              name: job.name,
              attempt: job.run_attempt,
              runId: job.run_id,
              headSha: job.head_sha,
              status: job.status,
              conclusion: job.conclusion,
              startedAt: job.started_at,
              completedAt: job.completed_at,
              steps: job.steps,
            })),
        ),
      ),
    });
  }
  return { history, executions: [...executions.values()] };
}

/** Every candidate, including an excluded failure, must have one genuine execution. */
export function retainedArtifactExecution(
  artifact: Record<string, unknown>,
  name: string,
  executions: readonly RetainedExecution[],
  runId: number,
  producerSha: string,
  fail: () => never,
): { id: number; digest: string; createdAt: string; execution: RetainedExecution } {
  const workflowRun = artifact.workflow_run;
  if (
    !id(artifact.id) ||
    artifact.expired !== false ||
    typeof artifact.digest !== 'string' ||
    !/^sha256:[a-f\d]{64}$/.test(artifact.digest) ||
    !workflowRun ||
    typeof workflowRun !== 'object' ||
    Array.isArray(workflowRun) ||
    !('id' in workflowRun) ||
    workflowRun.id !== runId ||
    !('head_sha' in workflowRun) ||
    workflowRun.head_sha !== producerSha ||
    typeof artifact.created_at !== 'string' ||
    !Number.isFinite(Date.parse(artifact.created_at))
  )
    return fail();
  const created = Date.parse(artifact.created_at);
  const matches = executions.filter(
    (entry) =>
      entry.name === name && created >= Date.parse(entry.startedAt) && created <= Date.parse(entry.completedAt),
  );
  if (matches.length !== 1) return fail();
  return { id: artifact.id, digest: artifact.digest, createdAt: artifact.created_at, execution: matches[0] };
}
