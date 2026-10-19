/// <reference types="node" />

/** Critical intent is consumed by a trusted attempt, independently of other deployment jobs. */
import { githubId, MAX_GITHUB_JOB_PAGES, SOURCE_WORKFLOW } from './ota-stable-github.ts';

const FULL_SHA = /^[a-f0-9]{40}$/;
const MAX_RUN_PAGES = 10;
const MAX_API_REQUESTS = 250;
const PROMOTION_JOB = 'promote-mobile-ota';
const CRITICAL_STEP = 'Release critical staged bytes to 100% stable';

export interface CriticalReleaseHistoryOptions {
  repository: string;
  currentRunId: string;
  headSha: string;
  deploymentBaseSha: string;
  git: (argumentsList: string[]) => string;
  github: (endpoint: string) => Promise<unknown>;
}

function object(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new Error(`Malformed critical publication ${label}.`);
  return input as Record<string, unknown>;
}

/**
 * A terminal critical step consumes its authorization even if publication was
 * partial or unsuccessful. A fresh reviewed critical merge can authorize recovery;
 * the old request cannot silently release another HEAD. Unfinished writers block.
 */
export async function latestConsumedCriticalRelease(options: CriticalReleaseHistoryOptions): Promise<string | null> {
  const { repository, headSha, deploymentBaseSha, git } = options;
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !FULL_SHA.test(headSha) ||
    (deploymentBaseSha !== '' && !FULL_SHA.test(deploymentBaseSha))
  )
    throw new Error('Critical publication history requires an exact repository and full commit SHAs.');
  const currentRunId = githubId(options.currentRunId, 'Current production run id');
  const isAncestor = (ancestor: string, descendant: string): boolean => {
    const mergeBase = git(['merge-base', ancestor, descendant]).trim();
    if (!FULL_SHA.test(mergeBase)) throw new Error('Critical publication ancestry cannot be proven.');
    return mergeBase === ancestor;
  };
  if (deploymentBaseSha && !isAncestor(deploymentBaseSha, headSha))
    throw new Error('Critical publication deployment baseline is not an ancestor of HEAD.');
  let apiRequests = 0;
  const request = async (endpoint: string): Promise<unknown> => {
    apiRequests += 1;
    if (apiRequests > MAX_API_REQUESTS)
      throw new Error('Critical publication history exceeded its bounded API budget.');
    return options.github(endpoint);
  };
  let consumedHead: string | null = null;
  const consume = (attemptedHead: string): void => {
    if (consumedHead === null || isAncestor(consumedHead, attemptedHead)) consumedHead = attemptedHead;
    else if (!isAncestor(attemptedHead, consumedHead))
      throw new Error('Critical release consumption boundaries diverge.');
  };
  const seenRuns = new Set<number>();
  for (let page = 1; page <= MAX_RUN_PAGES; page += 1) {
    const listing = object(
      await request(
        `repos/${repository}/actions/workflows/production-deploy.yml/runs?branch=main&per_page=100&page=${page}`,
      ),
      'workflow listing',
    );
    if (!Array.isArray(listing.workflow_runs) || listing.workflow_runs.length > 100)
      throw new Error('Malformed critical publication workflow listing.');
    for (const inputRun of listing.workflow_runs) {
      const run = object(inputRun, 'workflow run');
      const runId = githubId(run.id, 'Prior production run id');
      // Allocation order cannot turn this deployment or a queued successor into
      // evidence that an earlier critical request has already been published.
      if (runId >= currentRunId) continue;
      if (seenRuns.has(runId)) throw new Error('Duplicate critical publication workflow run.');
      seenRuns.add(runId);
      if (
        run.path !== SOURCE_WORKFLOW ||
        run.head_branch !== 'main' ||
        object(run.repository, 'run repository').full_name !== repository ||
        object(run.head_repository, 'run head repository').full_name !== repository ||
        !['push', 'workflow_dispatch'].includes(String(run.event)) ||
        typeof run.head_sha !== 'string' ||
        !FULL_SHA.test(run.head_sha) ||
        typeof run.status !== 'string' ||
        (run.conclusion !== null && typeof run.conclusion !== 'string')
      )
        throw new Error('Critical publication history contains an untrusted production run.');
      githubId(run.run_attempt, 'Prior production run attempt');
      const publishedHead = run.head_sha;
      if (!isAncestor(publishedHead, headSha)) continue;
      if (deploymentBaseSha && isAncestor(publishedHead, deploymentBaseSha)) {
        // A successful whole deployment already bounds all intent at this SHA.
        if (run.status === 'completed' && run.conclusion === 'success') return consumedHead;
        continue;
      }
      const jobs: Record<string, unknown>[] = [];
      let total: number | null = null;
      for (let jobPage = 1; jobPage <= MAX_GITHUB_JOB_PAGES; jobPage += 1) {
        const response = object(
          await request(`repos/${repository}/actions/runs/${runId}/attempts/1/jobs?per_page=100&page=${jobPage}`),
          'job listing',
        );
        if (
          !Array.isArray(response.jobs) ||
          !Number.isSafeInteger(response.total_count) ||
          Number(response.total_count) < 0 ||
          response.jobs.length > 100 ||
          (total !== null && total !== response.total_count)
        )
          throw new Error('Critical publication job pagination is incomplete.');
        total = Number(response.total_count);
        jobs.push(...response.jobs.map((job: unknown) => object(job, 'job')));
        if (jobs.length === total) break;
        if (jobs.length > total || response.jobs.length !== 100 || jobPage === MAX_GITHUB_JOB_PAGES)
          throw new Error('Critical publication job pagination is incomplete.');
      }
      const seenJobs = new Set<number>();
      for (const job of jobs) {
        const jobId = githubId(job.id, 'Critical publication job id');
        if (
          seenJobs.has(jobId) ||
          job.run_id !== runId ||
          job.run_attempt !== 1 ||
          job.head_sha !== publishedHead ||
          job.run_url !== `https://api.github.com/repos/${repository}/actions/runs/${runId}` ||
          typeof job.name !== 'string'
        )
          throw new Error('Critical publication job provenance is invalid.');
        seenJobs.add(jobId);
      }
      const promotions = jobs.filter((job) => job.name === PROMOTION_JOB);
      if (
        promotions.length === 0 &&
        jobs.length === 0 &&
        run.status === 'completed' &&
        ['startup_failure', 'cancelled'].includes(String(run.conclusion))
      )
        continue;
      if (promotions.length !== 1) throw new Error('Critical publication promotion job is missing or ambiguous.');
      const promotion = promotions[0];
      if (
        !['queued', 'pending', 'waiting', 'requested', 'in_progress', 'completed'].includes(String(promotion.status)) ||
        (promotion.conclusion !== null && typeof promotion.conclusion !== 'string')
      )
        throw new Error('Critical publication promotion job status is invalid.');
      const stepInputs = promotion.conclusion === 'skipped' && promotion.steps === undefined ? [] : promotion.steps;
      if (!Array.isArray(stepInputs)) throw new Error('Critical publication step evidence is missing.');
      if (promotion.conclusion === 'skipped' && (promotion.status !== 'completed' || stepInputs.length !== 0))
        throw new Error('Skipped critical publication job has contradictory step evidence.');
      const criticalSteps = stepInputs
        .map((step: unknown) => object(step, 'step'))
        .filter((step) => step.name === CRITICAL_STEP);
      if (criticalSteps.length > 1) throw new Error('Critical publication step evidence is ambiguous.');
      const step = criticalSteps[0];
      if (
        step?.status === 'completed' &&
        ['success', 'failure', 'cancelled', 'timed_out'].includes(String(step.conclusion))
      ) {
        consume(publishedHead);
        if (step.conclusion !== 'success')
          console.warn(
            `::warning::Critical OTA attempt in run ${runId} ended ${String(step.conclusion)}; its authorization through ${publishedHead} is consumed. Inspect production heads and use a fresh reviewed critical PR for recovery.`,
          );
        if (deploymentBaseSha === '' && run.status === 'completed' && run.conclusion === 'success') return consumedHead;
        continue;
      }
      if (
        !step ||
        (step.status === 'completed' && step.conclusion === 'skipped') ||
        (step.status === 'queued' && step.conclusion === null)
      ) {
        // Initial/manual history may lack the usual successful baseline. Once a
        // complete successful run is inspected, older intent is irrelevant to
        // the detector's HEAD-only fallback and cannot justify a new release.
        if (deploymentBaseSha === '' && run.status === 'completed' && run.conclusion === 'success') {
          return consumedHead;
        }
        continue;
      }
      throw new Error('A prior critical release step is unfinished or invalid; wait for its writer before releasing.');
    }
    if (listing.workflow_runs.length < 100) {
      return consumedHead;
    }
  }
  throw new Error('Critical publication history was truncated; inspect publication history before releasing.');
}
