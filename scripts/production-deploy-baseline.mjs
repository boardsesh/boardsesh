#!/usr/bin/env node

/**
 * Selects the component-diff baseline for the unified production workflow.
 *
 * The push event's before-SHA is the changelog snapshot boundary, but it is not
 * proof that the preceding code reached production: that run may have failed,
 * been cancelled, or staged under an active rollback. The most recent completed
 * Production Deploy run is trusted only when it succeeded with an explicit
 * successful promotion-marker job and its head is an ancestor of this
 * deployment. A workflow-owned changelog-only [skip ci] commit may sit between
 * that promoted head and the event before-SHA.
 *
 * Any missing or ambiguous evidence fails closed to a full release. No mutable
 * "last deployed" marker is written; GitHub Actions history is read at run time.
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const ZERO_SHA = '0000000000000000000000000000000000000000';

export const GENERATED_CHANGELOG_COMMIT_SUBJECT = 'chore(changelog): refresh from merged PRs [skip ci]';
const GENERATED_CHANGELOG_AUTHOR_EMAIL = 'github-actions[bot]@users.noreply.github.com';

const GENERATED_CHANGELOG_PATHS = new Set(['CHANGELOG.md', 'packages/mobile/src/data/changelog.generated.json']);

function force(reason) {
  return { forceComponents: true, componentBaseSha: null, reason };
}

function selectLatestCompletedRun(previousRunsResponse) {
  if (!previousRunsResponse || !Array.isArray(previousRunsResponse.workflow_runs)) {
    return { run: null, reason: 'production workflow history is unavailable' };
  }
  if (previousRunsResponse.workflow_runs.length === 0) {
    return { run: null, reason: 'no completed production deployment exists' };
  }

  const candidates = previousRunsResponse.workflow_runs.map((run) => ({
    run,
    completedAt: typeof run?.updated_at === 'string' ? Date.parse(run.updated_at) : Number.NaN,
  }));
  if (candidates.some(({ completedAt }) => !Number.isFinite(completedAt))) {
    return { run: null, reason: 'production completion timestamps are unavailable' };
  }
  candidates.sort((left, right) => right.completedAt - left.completedAt);
  if (candidates.length > 1 && candidates[0].completedAt === candidates[1].completedAt) {
    return { run: null, reason: 'latest production completion is ambiguous' };
  }
  return { run: candidates[0].run, reason: null };
}

function isWorkflowGeneratedChangelogCommit(commit) {
  return (
    commit?.subject === GENERATED_CHANGELOG_COMMIT_SUBJECT &&
    commit?.parentCount === 1 &&
    commit?.authorEmail === GENERATED_CHANGELOG_AUTHOR_EMAIL &&
    Array.isArray(commit.changedFiles) &&
    commit.changedFiles.length > 0 &&
    commit.changedFiles.every((filePath) => GENERATED_CHANGELOG_PATHS.has(filePath))
  );
}

function isWorkflowGeneratedChangelogSequence(commits) {
  return Array.isArray(commits) && commits.length > 0 && commits.every(isWorkflowGeneratedChangelogCommit);
}

export function classifyProductionTarget({ deploySha, currentMainSha, isAncestor, commitsBetween }) {
  if (deploySha === currentMainSha) {
    return { superseded: false, changelogSnapshotSha: null, reason: 'target is current main' };
  }
  if (!isAncestor(deploySha, currentMainSha)) {
    return {
      superseded: true,
      changelogSnapshotSha: null,
      reason: 'target is not an ancestor of current main',
    };
  }
  try {
    const commitsAhead = commitsBetween(deploySha, currentMainSha);
    if (isWorkflowGeneratedChangelogSequence(commitsAhead)) {
      return {
        superseded: false,
        changelogSnapshotSha: commitsAhead.at(-1)?.sha ?? null,
        reason: 'only positively identified workflow changelog commits are ahead of target',
      };
    }
    return {
      superseded: true,
      changelogSnapshotSha: null,
      reason: 'newer source changes exist on main',
    };
  } catch {
    return {
      superseded: true,
      changelogSnapshotSha: null,
      reason: 'could not classify changes ahead of target',
    };
  }
}

export function selectProductionDeployBaseline({
  deploySha,
  changelogBaseSha,
  previousRunsResponse,
  previousJobsResponse,
  isAncestor,
  commitsBetween,
}) {
  if (changelogBaseSha === ZERO_SHA) return force('changelog base is unavailable');
  const { run: previousRun, reason: runSelectionFailure } = selectLatestCompletedRun(previousRunsResponse);
  if (!previousRun) return force(runSelectionFailure);
  if (previousRun.conclusion !== 'success') {
    return force(`previous production deployment concluded ${previousRun.conclusion ?? 'unknown'}`);
  }
  if (!previousJobsResponse || !Array.isArray(previousJobsResponse.jobs)) {
    return force('previous production job outcomes are unavailable');
  }
  if (previousJobsResponse.jobs.some((job) => job?.name === 'notify-no-promote' && job?.conclusion === 'success')) {
    return force('previous production deployment was rollback-held');
  }
  if (
    !previousJobsResponse.jobs.some((job) => job?.name === 'mark-production-promoted' && job?.conclusion === 'success')
  ) {
    return force('previous production deployment has no successful promotion marker');
  }

  const previousDeploySha = typeof previousRun.head_sha === 'string' ? previousRun.head_sha : '';
  if (!previousDeploySha || !isAncestor(previousDeploySha, deploySha)) {
    return force('previous production commit is not an ancestor of this deployment');
  }

  if (previousDeploySha === changelogBaseSha) {
    return {
      forceComponents: false,
      componentBaseSha: previousDeploySha,
      reason: 'immediate predecessor is proven promoted',
    };
  }

  if (!isAncestor(previousDeploySha, changelogBaseSha)) {
    return force('event predecessor does not descend from the previous production commit');
  }
  let interveningCommits;
  try {
    interveningCommits = commitsBetween(previousDeploySha, changelogBaseSha);
  } catch {
    return force('could not classify commits after the previous production deployment');
  }
  if (!isWorkflowGeneratedChangelogSequence(interveningCommits)) {
    return force('unpromoted non-changelog changes exist after the previous production commit');
  }

  return {
    forceComponents: false,
    componentBaseSha: previousDeploySha,
    reason: 'previous production commit is followed only by workflow-owned changelog files',
  };
}

export function selectChangelogSnapshotSha({ deploySha, currentMainSha, isAncestor, commitsBetween }) {
  if (deploySha === currentMainSha || !isAncestor(deploySha, currentMainSha)) return null;

  try {
    const commitsAhead = commitsBetween(deploySha, currentMainSha);
    if (!isWorkflowGeneratedChangelogSequence(commitsAhead)) return null;
    const newestCommit = commitsAhead.at(-1);
    return typeof newestCommit?.sha === 'string' ? newestCommit.sha : null;
  } catch {
    // The caller falls back to its validated changelog base when history moved.
  }
  return null;
}

function readGitHubJson(apiPath) {
  return JSON.parse(
    execFileSync('gh', ['api', apiPath], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
  );
}

function gitIsAncestor(ancestorSha, descendantSha) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestorSha, descendantSha], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function gitCommitsBetween(baseSha, targetSha) {
  const commitShas = execFileSync('git', ['rev-list', '--reverse', '--ancestry-path', `${baseSha}..${targetSha}`], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean);

  return commitShas.map((sha) => {
    const subject = execFileSync('git', ['show', '-s', '--format=%s', sha], {
      encoding: 'utf8',
    }).trimEnd();
    const authorEmail = execFileSync('git', ['show', '-s', '--format=%ae', sha], {
      encoding: 'utf8',
    }).trimEnd();
    const commitWithParents = execFileSync('git', ['rev-list', '--parents', '-n', '1', sha], {
      encoding: 'utf8',
    })
      .trim()
      .split(/\s+/);
    const parentCount = commitWithParents.length - 1;
    const parentSha = execFileSync('git', ['rev-parse', `${sha}^`], {
      encoding: 'utf8',
    }).trim();
    const changedFiles = execFileSync('git', ['diff', '--name-only', parentSha, sha], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
      .split('\n')
      .filter(Boolean);
    return { sha, subject, authorEmail, parentCount, changedFiles };
  });
}

function evaluateFromEnvironment() {
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const deploySha = process.env.DEPLOY_SHA ?? '';
  const changelogBaseSha = process.env.CHANGELOG_BASE_SHA ?? '';
  const currentMainSha = process.env.CURRENT_MAIN_SHA ?? '';
  const targetClassification = classifyProductionTarget({
    deploySha,
    currentMainSha,
    isAncestor: gitIsAncestor,
    commitsBetween: gitCommitsBetween,
  });
  if (targetClassification.superseded) {
    return {
      superseded: true,
      forceComponents: false,
      componentBaseSha: null,
      changelogSnapshotSha: null,
      reason: targetClassification.reason,
    };
  }
  let previousRunsResponse = null;
  let previousJobsResponse = null;

  try {
    previousRunsResponse = readGitHubJson(
      `repos/${repository}/actions/workflows/production-deploy.yml/runs?status=completed&per_page=100`,
    );
    const { run: previousRun } = selectLatestCompletedRun(previousRunsResponse);
    const previousRunId = previousRun?.id;
    if (previousRunId !== undefined && previousRunId !== null) {
      previousJobsResponse = readGitHubJson(
        `repos/${repository}/actions/runs/${previousRunId}/jobs?filter=latest&per_page=100`,
      );
    }
  } catch {
    // The pure selector treats unavailable API responses as a conservative full release.
  }

  return {
    superseded: false,
    changelogSnapshotSha: targetClassification.changelogSnapshotSha,
    ...selectProductionDeployBaseline({
      deploySha,
      changelogBaseSha,
      previousRunsResponse,
      previousJobsResponse,
      isAncestor: gitIsAncestor,
      commitsBetween: gitCommitsBetween,
    }),
  };
}

function selectChangelogSnapshotFromEnvironment() {
  const deploySha = process.env.DEPLOY_SHA ?? '';
  const currentMainSha = process.env.CURRENT_MAIN_SHA ?? '';
  return selectChangelogSnapshotSha({
    deploySha,
    currentMainSha,
    isAncestor: gitIsAncestor,
    commitsBetween: gitCommitsBetween,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'changelog-snapshot') {
    process.stdout.write(`${selectChangelogSnapshotFromEnvironment() ?? ''}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(evaluateFromEnvironment())}\n`);
  }
}
