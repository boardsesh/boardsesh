/// <reference types="node" />

import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, onTestFinished } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cleanupScript = join(repositoryRoot, 'scripts/cleanup-merged-worktrees.sh');

type Fixture = {
  candidateHead: string;
  candidateWorktree: string;
  primaryWorktree: string;
  scriptPath: string;
  stubBinDirectory: string;
};

type PullRequest = {
  headRefOid?: string;
  mergeCommit: null | { oid: string };
  mergedAt: null | string;
  number: number;
  state: 'MERGED' | 'OPEN';
  url: string;
};

function run(command: string, args: string[], cwd: string, extraEnvironment: NodeJS.ProcessEnv = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      ...extraEnvironment,
    },
  });
}

function runGit(args: string[], cwd: string, extraEnvironment: NodeJS.ProcessEnv = {}): string {
  const result = run('git', args, cwd, extraEnvironment);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, 'utf8');
  await chmod(path, 0o755);
}

async function createFixture(headAgeSeconds: number): Promise<Fixture> {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'boardsesh-worktree-cleanup-'));
  onTestFinished(() => rm(rootDirectory, { force: true, recursive: true }));

  const bareRepository = join(rootDirectory, 'origin.git');
  const primaryWorktree = join(rootDirectory, 'main');
  const candidateWorktree = join(rootDirectory, 'feature');
  const stubBinDirectory = join(rootDirectory, 'stub-bin');
  const scriptPath = join(primaryWorktree, 'scripts/cleanup-merged-worktrees.sh');

  const initResult = run('git', ['init', '--bare', '--initial-branch=main', bareRepository], rootDirectory);
  expect(initResult.status, initResult.stderr).toBe(0);
  const cloneResult = run('git', ['clone', bareRepository, primaryWorktree], rootDirectory);
  expect(cloneResult.status, cloneResult.stderr).toBe(0);

  runGit(['config', 'user.email', 'cleanup@example.com'], primaryWorktree);
  runGit(['config', 'user.name', 'Cleanup Fixture'], primaryWorktree);
  await writeFile(join(primaryWorktree, 'README.md'), '# cleanup fixture\n', 'utf8');
  runGit(['add', 'README.md'], primaryWorktree);
  runGit(['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'chore: seed cleanup fixture'], primaryWorktree);
  runGit(['push', '-u', 'origin', 'main'], primaryWorktree);

  runGit(['worktree', 'add', '-b', 'feature', candidateWorktree, 'main'], primaryWorktree);
  await writeFile(join(candidateWorktree, 'feature.txt'), 'finished feature\n', 'utf8');
  runGit(['add', 'feature.txt'], candidateWorktree);

  const commitTimestamp = Math.floor(Date.now() / 1000) - headAgeSeconds;
  const commitEnvironment = {
    GIT_AUTHOR_DATE: `@${commitTimestamp} +0000`,
    GIT_COMMITTER_DATE: `@${commitTimestamp} +0000`,
  };
  runGit(
    ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'feat: finish worktree change'],
    candidateWorktree,
    commitEnvironment,
  );
  const candidateHead = runGit(['rev-parse', 'HEAD'], candidateWorktree);

  await mkdir(dirname(scriptPath), { recursive: true });
  await mkdir(stubBinDirectory, { recursive: true });
  await cp(cleanupScript, scriptPath);
  await chmod(scriptPath, 0o755);
  await writeExecutable(
    join(stubBinDirectory, 'gh'),
    '#!/bin/sh\n' +
      'if [ "$1" = auth ] && [ "$2" = status ]; then exit 0; fi\n' +
      'if [ "$1" = pr ] && [ "$2" = list ]; then\n' +
      '  while [ "$#" -gt 0 ]; do\n' +
      '    if [ "$1" = --head ]; then shift; head_branch="$1"; break; fi\n' +
      '    shift\n' +
      '  done\n' +
      '  if [ "$head_branch" = feature ]; then printf "%s\\n" "$GH_PR_JSON"; exit 0; fi\n' +
      '  if [ "$head_branch" = trigger ] && [ -n "$GH_MUTATE_WORKTREE" ]; then\n' +
      '    git -c core.hooksPath=/dev/null -C "$GH_MUTATE_WORKTREE" commit --allow-empty -m "test: advance after scan" >/dev/null 2>&1\n' +
      '  fi\n' +
      '  printf "%s\\n" "${GH_OTHER_PR_JSON:-[]}"\n' +
      '  exit 0\n' +
      'fi\n' +
      'exit 1\n',
  );

  return {
    candidateHead,
    candidateWorktree,
    primaryWorktree,
    scriptPath,
    stubBinDirectory,
  };
}

function openPullRequest(headRefOid?: string): PullRequest {
  return {
    ...(headRefOid === undefined ? {} : { headRefOid }),
    mergeCommit: null,
    mergedAt: null,
    number: 42,
    state: 'OPEN',
    url: 'https://github.com/boardsesh/boardsesh/pull/42',
  };
}

function runCleanup(
  fixture: Fixture,
  pullRequests: PullRequest[],
  args: string[] = [],
  extraEnvironment: NodeJS.ProcessEnv = {},
) {
  return run('bash', [fixture.scriptPath, ...args], fixture.primaryWorktree, {
    GH_PR_JSON: JSON.stringify(pullRequests),
    PATH: `${fixture.stubBinDirectory}:${process.env.PATH ?? ''}`,
    ...extraEnvironment,
  });
}

describe('cleanup-merged-worktrees open PR handling', () => {
  it('shows both dry-run and apply invocations in help output', () => {
    const result = run('bash', [cleanupScript, '--help'], repositoryRoot);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('./cleanup-merged-worktrees.sh           # dry-run');
    expect(result.stdout).toContain('./cleanup-merged-worktrees.sh --apply   # actually remove');
  });

  it('removes a clean, in-sync open PR worktree once HEAD is 48 hours old', async () => {
    const fixture = await createFixture(48 * 60 * 60);

    const result = runCleanup(fixture, [openPullRequest(fixture.candidateHead)], ['--apply']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('PR #42 OPEN and in sync, HEAD 48h old');
    expect(result.stdout).toContain('Eligible for removal: 1');
    expect(result.stdout).toContain('Removed: 1');
    expect(runGit(['worktree', 'list', '--porcelain'], fixture.primaryWorktree)).not.toContain(
      fixture.candidateWorktree,
    );
    expect(
      run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/feature'], fixture.primaryWorktree).status,
    ).not.toBe(0);
  });

  it('keeps an in-sync open PR worktree whose HEAD is younger than 48 hours', async () => {
    const fixture = await createFixture(47 * 60 * 60);

    const result = runCleanup(fixture, [openPullRequest(fixture.candidateHead)]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('PR #42 OPEN and in sync, but HEAD is 47h old');
    expect(result.stdout).toContain('Eligible for removal: 0');
    expect(result.stdout).toContain('Skipped — too fresh:  1');
  });

  it('keeps an old open PR worktree when its local HEAD is not the PR head', async () => {
    const fixture = await createFixture(72 * 60 * 60);
    const historicalMergedPullRequest: PullRequest = {
      headRefOid: fixture.candidateHead,
      mergeCommit: { oid: fixture.candidateHead },
      mergedAt: '2026-01-01T00:00:00Z',
      number: 12,
      state: 'MERGED',
      url: 'https://github.com/boardsesh/boardsesh/pull/12',
    };

    const result = runCleanup(fixture, [
      historicalMergedPullRequest,
      openPullRequest('0000000000000000000000000000000000000000'),
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('PR #42 OPEN, but local HEAD is not in sync with PR head');
    expect(result.stdout).toContain('Eligible for removal: 0');
    expect(result.stdout).toContain('Skipped — open PR:    1');
  });

  it('keeps an old open PR worktree when GitHub omits the PR head OID', async () => {
    const fixture = await createFixture(72 * 60 * 60);

    const result = runCleanup(fixture, [openPullRequest()]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('PR #42 OPEN, but local HEAD is not in sync with PR head');
    expect(result.stdout).toContain('Eligible for removal: 0');
  });

  it('keeps an old, in-sync open PR worktree when it has uncommitted changes', async () => {
    const fixture = await createFixture(72 * 60 * 60);
    await writeFile(join(fixture.candidateWorktree, 'uncommitted.txt'), 'keep me\n', 'utf8');

    const result = runCleanup(fixture, [openPullRequest(fixture.candidateHead)]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('PR #42 OPEN, but 1 uncommitted file(s)');
    expect(result.stdout).toContain('Eligible for removal: 0');
    expect(result.stdout).toContain('Skipped — dirty:      1');
  });

  it('keeps an in-sync open PR worktree whose HEAD timestamp is in the future', async () => {
    const fixture = await createFixture(-90 * 60);

    const result = runCleanup(fixture, [openPullRequest(fixture.candidateHead)]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('PR #42 OPEN and in sync, but HEAD is -1h old');
    expect(result.stdout).toContain('Eligible for removal: 0');
    expect(result.stdout).toContain('Skipped — too fresh:  1');
  });

  it('revalidates an open PR worktree immediately before applying removal', async () => {
    const fixture = await createFixture(72 * 60 * 60);
    const triggerWorktree = join(dirname(fixture.primaryWorktree), 'trigger');
    runGit(['worktree', 'add', '-b', 'trigger', triggerWorktree, 'main'], fixture.primaryWorktree);

    const result = runCleanup(fixture, [openPullRequest(fixture.candidateHead)], ['--apply'], {
      GH_MUTATE_WORKTREE: fixture.candidateWorktree,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Eligible for removal: 1');
    expect(result.stdout).toContain('worktree changed after eligibility scan');
    expect(result.stdout).toContain('Removed: 0');
    expect(result.stdout).toContain('Skipped after scan: 1');
    expect(runGit(['rev-parse', 'HEAD'], fixture.candidateWorktree)).not.toBe(fixture.candidateHead);
    expect(runGit(['rev-parse', 'feature'], fixture.primaryWorktree)).not.toBe(fixture.candidateHead);
  });
});
