#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasCriticalOtaRelease } from '../packages/shared/pr-body/src/ota-release.ts';
import { latestConsumedCriticalRelease } from './lib/ota-critical-history.ts';

const FULL_SHA = /^[a-f0-9]{40}$/;
const MAX_COMMITS = 100;
const MAX_ASSOCIATED_PAGES = 3;
const MAX_API_REQUESTS = 250;

interface CriticalOtaOptions {
  repository: string;
  headSha: string;
  deploymentBaseSha: string;
  criticalConsumptionSha?: string | null;
  git: (argumentsList: string[]) => string;
  github: (endpoint: string) => Promise<unknown>;
  graphql: (query: string) => Promise<unknown>;
}

interface PullIdentity {
  number: number;
  mergeCommitSha: string | null;
  baseRepository: string;
  baseRef: string;
}

export interface CriticalOtaDecision {
  critical: boolean;
  pullNumbers: number[];
  inspectedCommits: number;
  headOnlyFallback: boolean;
}

function record(payload: unknown, context: string): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`Malformed ${context}.`);
  }
  return payload as Record<string, unknown>;
}

function pullIdentity(payload: unknown): PullIdentity {
  const pull = record(payload, 'pull request');
  const base = record(pull.base, 'pull request base');
  const repository = record(base.repo, 'pull request base repository');
  if (
    !Number.isSafeInteger(pull.number) ||
    (pull.number as number) <= 0 ||
    (pull.merge_commit_sha !== null && typeof pull.merge_commit_sha !== 'string') ||
    typeof repository.full_name !== 'string' ||
    typeof base.ref !== 'string'
  ) {
    throw new Error('Malformed associated pull request identity.');
  }
  return {
    number: pull.number as number,
    mergeCommitSha: pull.merge_commit_sha,
    baseRepository: repository.full_name,
    baseRef: base.ref,
  };
}

/** Read-only: only merged PRs on the actual deployed first-parent range can opt in. */
export async function detectCriticalOtaRelease(options: CriticalOtaOptions): Promise<CriticalOtaDecision> {
  const { repository, headSha, deploymentBaseSha, git, github, graphql } = options;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !FULL_SHA.test(headSha)) {
    throw new Error('Critical OTA detection requires the exact repository and full deployment SHA.');
  }
  if (git(['rev-parse', '--verify', 'HEAD']).trim() !== headSha) {
    throw new Error('Checkout differs from the trusted deployment SHA.');
  }
  git(['merge-base', '--is-ancestor', headSha, 'refs/remotes/origin/main']);

  let authorizationBaseSha = deploymentBaseSha;
  if (options.criticalConsumptionSha) {
    const consumedSha = options.criticalConsumptionSha;
    if (!FULL_SHA.test(consumedSha)) throw new Error('Invalid critical consumption boundary SHA.');
    git(['merge-base', '--is-ancestor', consumedSha, headSha]);
    if (!authorizationBaseSha) authorizationBaseSha = consumedSha;
    else {
      const commonAncestor = git(['merge-base', authorizationBaseSha, consumedSha]).trim();
      if (commonAncestor === authorizationBaseSha) authorizationBaseSha = consumedSha;
      else if (commonAncestor !== consumedSha) throw new Error('Critical consumption boundaries diverge.');
    }
  }
  let commits: string[];
  if (authorizationBaseSha) {
    if (!FULL_SHA.test(authorizationBaseSha)) throw new Error('Invalid production deployment baseline SHA.');
    git(['merge-base', '--is-ancestor', authorizationBaseSha, headSha]);
    commits = git([
      'rev-list',
      '--first-parent',
      '--reverse',
      `--max-count=${MAX_COMMITS + 1}`,
      `${authorizationBaseSha}..${headSha}`,
    ])
      .trim()
      .split('\n')
      .filter(Boolean);
    if (commits.length > MAX_COMMITS || commits.some((commitSha) => !FULL_SHA.test(commitSha))) {
      throw new Error('Critical OTA deployment range is malformed or exceeds 100 commits; inspect it explicitly.');
    }
    if (
      (commits.length === 0 && authorizationBaseSha !== headSha) ||
      (commits.length > 0 &&
        (commits.at(-1) !== headSha || git(['rev-parse', `${commits[0]}^1`]).trim() !== authorizationBaseSha))
    ) {
      throw new Error('Production baseline must bound the complete first-parent deployment range.');
    }
  } else {
    commits = [headSha];
  }

  let apiRequests = 0;
  const request = async (endpoint: string): Promise<unknown> => {
    apiRequests += 1;
    if (apiRequests > MAX_API_REQUESTS) throw new Error('Critical OTA detection exceeded its bounded API budget.');
    return github(endpoint);
  };
  const checkedPullNumbers = new Set<number>();
  const criticalPullNumbers = new Set<number>();
  for (const commitSha of commits) {
    for (let page = 1; page <= MAX_ASSOCIATED_PAGES; page += 1) {
      const associated = await request(`repos/${repository}/commits/${commitSha}/pulls?per_page=100&page=${page}`);
      if (!Array.isArray(associated) || associated.length > 100) {
        throw new Error('Malformed associated pull request listing.');
      }
      for (const associatedPull of associated) {
        const identity = pullIdentity(associatedPull);
        if (
          identity.mergeCommitSha !== commitSha ||
          identity.baseRepository !== repository ||
          identity.baseRef !== 'main' ||
          checkedPullNumbers.has(identity.number)
        ) {
          continue;
        }
        checkedPullNumbers.add(identity.number);
        // Read body and edit/merge timestamps atomically. A REST body followed by
        // a separate timestamp read could authorize a concurrent post-merge edit.
        const [owner, name] = repository.split('/');
        apiRequests += 1;
        if (apiRequests > MAX_API_REQUESTS) throw new Error('Critical OTA detection exceeded its bounded API budget.');
        const response = record(
          await graphql(`query { repository(owner: "${owner}", name: "${name}") {
            pullRequest(number: ${identity.number}) {
              number body merged mergedAt createdAt lastEditedAt
              mergeCommit { oid } baseRepository { nameWithOwner } baseRefName
            }
          } }`),
          'merged pull request response',
        );
        if (response.errors !== undefined) throw new Error('Incomplete merged pull request verification.');
        const pull = record(
          record(record(response.data, 'pull request data').repository, 'pull request repository').pullRequest,
          'merged pull request',
        );
        const verifiedIdentity = pullIdentity({
          number: pull.number,
          merge_commit_sha: pull.mergeCommit === null ? null : record(pull.mergeCommit, 'merge commit').oid,
          base: {
            repo: { full_name: record(pull.baseRepository, 'base repository').nameWithOwner },
            ref: pull.baseRefName,
          },
        });
        if (
          typeof pull.merged !== 'boolean' ||
          (pull.body !== null && typeof pull.body !== 'string') ||
          verifiedIdentity.number !== identity.number
        ) {
          throw new Error('Malformed merged pull request verification.');
        }
        if (
          pull.merged &&
          verifiedIdentity.mergeCommitSha === commitSha &&
          verifiedIdentity.baseRepository === repository &&
          verifiedIdentity.baseRef === 'main' &&
          hasCriticalOtaRelease(pull.body)
        ) {
          const mergedAt = typeof pull.mergedAt === 'string' ? Date.parse(pull.mergedAt) : NaN;
          const bodyWrittenAt = pull.lastEditedAt === null ? pull.createdAt : pull.lastEditedAt;
          const writtenAt = typeof bodyWrittenAt === 'string' ? Date.parse(bodyWrittenAt) : NaN;
          if (!Number.isFinite(mergedAt) || !Number.isFinite(writtenAt))
            throw new Error('Cannot prove critical OTA authorization existed before merge.');
          // Equality is ambiguous at GitHub's timestamp precision. Never grant
          // a bypass from an edit made during or after the merge second.
          if (writtenAt >= mergedAt) {
            console.warn(
              `::warning::Ignoring critical OTA PR #${identity.number}: body edited at or after merge. Use a fresh reviewed PR.`,
            );
            continue;
          }
          criticalPullNumbers.add(identity.number);
        }
      }
      if (associated.length < 100) break;
      if (page === MAX_ASSOCIATED_PAGES) throw new Error('Associated pull request listing was truncated.');
    }
  }
  return {
    critical: criticalPullNumbers.size > 0,
    pullNumbers: [...criticalPullNumbers].sort((left, right) => left - right),
    inspectedCommits: commits.length,
    headOnlyFallback: authorizationBaseSha === '',
  };
}

async function main(): Promise<void> {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main') {
    throw new Error('Critical OTA detection only runs in a trusted main deployment.');
  }
  const execute = (program: string, argumentsList: string[]) =>
    execFileSync(program, argumentsList, { encoding: 'utf8', timeout: 20_000, maxBuffer: 10 * 1024 * 1024 });
  const context = {
    repository: process.env.GITHUB_REPOSITORY ?? '',
    headSha: process.env.GITHUB_SHA ?? '',
    deploymentBaseSha: process.env.DEPLOYMENT_BASE_SHA ?? '',
    git: (argumentsList: string[]) => execute('git', argumentsList),
    github: async (endpoint: string) => JSON.parse(execute('gh', ['api', '--method', 'GET', endpoint])) as unknown,
  };
  const criticalConsumptionSha = await latestConsumedCriticalRelease({
    ...context,
    currentRunId: process.env.GITHUB_RUN_ID ?? '',
  });
  const decision = await detectCriticalOtaRelease({
    ...context,
    criticalConsumptionSha,
    graphql: async (query) => JSON.parse(execute('gh', ['api', 'graphql', '-f', `query=${query}`])) as unknown,
  });
  if (decision.headOnlyFallback) {
    console.warn('::warning::No safe deployment baseline; checking HEAD only. Inherited critical intent is unknown.');
  }
  const consumedDescription = criticalConsumptionSha
    ? `Critical OTA authorization consumed through ${criticalConsumptionSha}; only later merges can request another bypass.\n`
    : '';
  const description =
    consumedDescription +
    (decision.critical
      ? `Critical OTA: PR ${decision.pullNumbers.map((pullNumber) => `#${pullNumber}`).join(', ')} requests immediate 100% stable release.`
      : `Normal OTA cadence: no critical checkbox in ${decision.inspectedCommits} deployed first-parent commits.`);
  console.log(description);
  if (!process.env.GITHUB_OUTPUT) throw new Error('Missing workflow output file.');
  appendFileSync(process.env.GITHUB_OUTPUT, `critical_ota=${decision.critical}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${description}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
