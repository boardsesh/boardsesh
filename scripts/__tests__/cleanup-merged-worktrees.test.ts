/// <reference types="node" />

import { spawn, spawnSync } from 'node:child_process';
import { access, chmod, cp, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

vi.setConfig({ testTimeout: 15_000 });

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cleanupScript = join(repositoryRoot, 'scripts/cleanup-merged-worktrees.sh');

type Fixture = {
  candidateHead: string;
  candidateWorktree: string;
  primaryWorktree: string;
  realGitPath: string;
  scriptPath: string;
  stubBinDirectory: string;
};

type PullRequest = {
  createdAt: string;
  headRefName: string;
  headRefOid?: string;
  isCrossRepository: boolean;
  mergeCommit: null | { oid: string };
  mergedAt: null | string;
  number: number;
  state: 'CLOSED' | 'MERGED' | 'OPEN';
  url: string;
};

// An override bag layered over process.env, not a complete environment — typing
// it as NodeJS.ProcessEnv would demand the NODE_ENV the repo's Next global.d.ts
// makes required, which no caller here wants to set.
type EnvironmentOverrides = Record<string, string | undefined>;

function run(command: string, args: string[], cwd: string, extraEnvironment: EnvironmentOverrides = {}) {
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

function runGit(args: string[], cwd: string, extraEnvironment: EnvironmentOverrides = {}): string {
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

async function setWorktreeInactivity(worktree: string, inactivitySeconds: number): Promise<void> {
  const activityTimestamp = new Date(Date.now() - inactivitySeconds * 1000);
  const administrativeHead = runGit(['rev-parse', '--path-format=absolute', '--git-path', 'HEAD'], worktree);
  await utimes(administrativeHead, activityTimestamp, activityTimestamp);
  const branchRef = run('git', ['symbolic-ref', '--quiet', 'HEAD'], worktree);
  if (branchRef.status === 0) {
    const branchRefPath = runGit(
      ['rev-parse', '--path-format=absolute', '--git-path', branchRef.stdout.trim()],
      worktree,
    );
    await utimes(branchRefPath, activityTimestamp, activityTimestamp);
  }
}

async function createFixture(headAgeSeconds: number, candidateRelativePath = 'feature'): Promise<Fixture> {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'boardsesh-worktree-cleanup-'));
  onTestFinished(() => rm(rootDirectory, { force: true, recursive: true }));

  const bareRepository = join(rootDirectory, 'origin.git');
  const primaryWorktree = join(rootDirectory, 'main');
  const candidateWorktree = join(rootDirectory, candidateRelativePath);
  const stubBinDirectory = join(rootDirectory, 'stub-bin');
  const scriptPath = join(primaryWorktree, 'scripts/cleanup-merged-worktrees.sh');
  const realGitResult = run('sh', ['-c', 'command -v git'], rootDirectory);
  expect(realGitResult.status, realGitResult.stderr).toBe(0);
  const realGitPath = realGitResult.stdout.trim();

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

  await mkdir(dirname(candidateWorktree), { recursive: true });
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
  await setWorktreeInactivity(candidateWorktree, headAgeSeconds);

  await mkdir(dirname(scriptPath), { recursive: true });
  await mkdir(stubBinDirectory, { recursive: true });
  await cp(cleanupScript, scriptPath);
  await chmod(scriptPath, 0o755);
  await writeExecutable(
    join(stubBinDirectory, 'gh'),
    '#!/bin/sh\n' +
      'if [ "$1" = auth ] && [ "$2" = status ]; then exit 0; fi\n' +
      'if [ "$1" = pr ] && [ "$2" = list ]; then\n' +
      '  if [ -n "${GH_PR_COUNT:-}" ]; then\n' +
      '    printf "["\n' +
      '    pr_index=1\n' +
      '    while [ "$pr_index" -le "$GH_PR_COUNT" ]; do\n' +
      '      if [ "$pr_index" -gt 1 ]; then printf ","; fi\n' +
      '      printf \'{"createdAt":"2026-01-01T00:00:00Z","headRefName":"unrelated","isCrossRepository":false,"mergeCommit":null,"mergedAt":null,"number":%s,"state":"CLOSED","url":"https://github.com/boardsesh/boardsesh/pull/%s"}\' "$pr_index" "$pr_index"\n' +
      '      pr_index=$((pr_index + 1))\n' +
      '    done\n' +
      '    printf "]\\n"\n' +
      '    exit 0\n' +
      '  fi\n' +
      '  printf "%s\\n" "$GH_PR_JSON"\n' +
      '  exit 0\n' +
      'fi\n' +
      'exit 1\n',
  );
  await writeExecutable(
    join(stubBinDirectory, 'git'),
    '#!/bin/sh\n' +
      'if [ -n "${GIT_DIRTY_ON_STATUS_COUNT_FILE:-}" ] && [ -n "${GIT_MUTATE_WORKTREE:-}" ] && ' +
      '[ "$#" -eq 4 ] && [ "$1" = -C ] && [ "$2" = "$GIT_MUTATE_WORKTREE" ] && ' +
      '[ "$3" = status ] && [ "$4" = --porcelain ]; then\n' +
      '  status_count=0\n' +
      '  if [ -f "$GIT_DIRTY_ON_STATUS_COUNT_FILE" ]; then IFS= read -r status_count < "$GIT_DIRTY_ON_STATUS_COUNT_FILE"; fi\n' +
      '  status_count=$((status_count + 1))\n' +
      '  printf "%s\\n" "$status_count" > "$GIT_DIRTY_ON_STATUS_COUNT_FILE"\n' +
      '  if [ "$status_count" -eq 2 ]; then printf "%s\\n" "changed during apply" > "$GIT_MUTATE_WORKTREE/apply-dirty.txt"; fi\n' +
      'fi\n' +
      'if [ -n "${GIT_MUTATE_WORKTREE:-}" ] && [ -n "${GIT_MUTATE_COUNT_FILE:-}" ] && ' +
      '[ "$#" -eq 4 ] && [ "$1" = -C ] && [ "$2" = "$GIT_MUTATE_WORKTREE" ] && ' +
      '[ "$3" = rev-parse ] && [ "$4" = HEAD ]; then\n' +
      '  mutation_count=0\n' +
      '  if [ -f "$GIT_MUTATE_COUNT_FILE" ]; then IFS= read -r mutation_count < "$GIT_MUTATE_COUNT_FILE"; fi\n' +
      '  mutation_count=$((mutation_count + 1))\n' +
      '  printf "%s\\n" "$mutation_count" > "$GIT_MUTATE_COUNT_FILE"\n' +
      '  if [ "$mutation_count" -eq 2 ]; then\n' +
      '    "$REAL_GIT_PATH" -c core.hooksPath=/dev/null -C "$GIT_MUTATE_WORKTREE" commit --allow-empty -m "test: advance before apply revalidation" >/dev/null 2>&1\n' +
      '  fi\n' +
      'fi\n' +
      'exec "$REAL_GIT_PATH" "$@"\n',
  );

  return {
    candidateHead,
    candidateWorktree,
    primaryWorktree,
    realGitPath,
    scriptPath,
    stubBinDirectory,
  };
}

function openPullRequest(headRefOid?: string): PullRequest {
  return {
    ...(headRefOid === undefined ? {} : { headRefOid }),
    createdAt: '2026-02-01T00:00:00Z',
    headRefName: 'feature',
    isCrossRepository: false,
    mergeCommit: null,
    mergedAt: null,
    number: 42,
    state: 'OPEN',
    url: 'https://github.com/boardsesh/boardsesh/pull/42',
  };
}

function mergedPullRequest(headRefOid: string): PullRequest {
  return {
    createdAt: '2026-01-01T00:00:00Z',
    headRefName: 'feature',
    headRefOid,
    isCrossRepository: false,
    mergeCommit: { oid: headRefOid },
    mergedAt: '2026-01-01T00:00:00Z',
    number: 41,
    state: 'MERGED',
    url: 'https://github.com/boardsesh/boardsesh/pull/41',
  };
}

function runCleanup(
  fixture: Fixture,
  pullRequests: PullRequest[],
  args: string[] = [],
  extraEnvironment: EnvironmentOverrides = {},
) {
  return run('bash', [fixture.scriptPath, ...args], fixture.primaryWorktree, {
    GH_PR_JSON: JSON.stringify(pullRequests),
    GITHUB_REPOSITORY_OVERRIDE: 'boardsesh/cleanup-fixture',
    PATH: `${fixture.stubBinDirectory}:${process.env.PATH ?? ''}`,
    REAL_GIT_PATH: fixture.realGitPath,
    ...extraEnvironment,
  });
}

describe('cleanup-merged-worktrees safety policy', () => {
  it('shows both dry-run and apply invocations in help output', () => {
    const result = run('bash', [cleanupScript, '--help'], repositoryRoot);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('./cleanup-merged-worktrees.sh           # dry-run');
    expect(result.stdout).toContain(
      './cleanup-merged-worktrees.sh --apply   # remove worktrees; preserve recovery refs',
    );
  });

  it('removes a clean, in-sync open PR worktree after 48 hours of worktree inactivity', async () => {
    const fixture = await createFixture(48 * 60 * 60);

    const result = runCleanup(fixture, [openPullRequest(fixture.candidateHead)], ['--apply']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('PR #42 OPEN and in sync; preserving branch; inactive 2d');
    expect(result.stdout).toContain('Eligible for removal: 1');
    expect(result.stdout).toContain('Removed: 1');
    expect(result.stdout).toContain('preserved local branch feature');
    expect(runGit(['worktree', 'list', '--porcelain'], fixture.primaryWorktree)).not.toContain(
      fixture.candidateWorktree,
    );
    await expect(access(fixture.candidateWorktree)).rejects.toThrow();
    expect(runGit(['rev-parse', 'feature'], fixture.primaryWorktree)).toBe(fixture.candidateHead);
  });

  it('deletes a merged branch only when its content is represented in main', async () => {
    const fixture = await createFixture(72 * 60 * 60);
    runGit(
      ['-c', 'core.hooksPath=/dev/null', 'merge', '--no-ff', 'feature', '-m', 'merge fixture feature'],
      fixture.primaryWorktree,
    );
    runGit(['push', 'origin', 'main'], fixture.primaryWorktree);

    const result = runCleanup(fixture, [mergedPullRequest(fixture.candidateHead)], ['--apply']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('PR #41 merged');
    expect(result.stdout).toContain('deleted branch feature');
    expect(
      run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/feature'], fixture.primaryWorktree).status,
    ).not.toBe(0);
  });

  it('removes a stale merged worktree with a divergent tip but preserves its branch', async () => {
    const fixture = await createFixture(72 * 60 * 60);
    const differentPullRequestHead = '0000000000000000000000000000000000000000';

    const result = runCleanup(fixture, [mergedPullRequest(differentPullRequestHead)], ['--apply']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('preserving branch with unique or divergent content');
    expect(result.stdout).toContain('Removed: 1');
    expect(runGit(['rev-parse', 'feature'], fixture.primaryWorktree)).toBe(fixture.candidateHead);
  });

  it('applies an inactivity floor even when the PR is merged', async () => {
    const fixture = await createFixture(30 * 24 * 60 * 60);
    await setWorktreeInactivity(fixture.candidateWorktree, 23 * 60 * 60);

    const result = runCleanup(fixture, [mergedPullRequest(fixture.candidateHead)]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('MERGED; inactive for 23h, minimum is 1d');
    expect(result.stdout).toContain('Eligible for removal: 0');
    expect(result.stdout).toContain('Skipped — too fresh:  1');
  });

  it('preserves a stale no-PR branch even when its content matches main', async () => {
    const fixture = await createFixture(8 * 24 * 60 * 60);
    runGit(['-c', 'core.hooksPath=/dev/null', 'cherry-pick', fixture.candidateHead], fixture.primaryWorktree);
    runGit(['push', 'origin', 'main'], fixture.primaryWorktree);
    runGit(['config', 'diff.external', ''], fixture.primaryWorktree);

    const result = runCleanup(fixture, [], ['--apply']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('no PR; content is in origin/main; preserving branch; inactive 8d');
    expect(result.stdout).toContain('preserved local branch feature');
    expect(runGit(['rev-parse', 'feature'], fixture.primaryWorktree)).toBe(fixture.candidateHead);
  });

  it('removes a stale clean no-PR worktree with unique commits and preserves its branch', async () => {
    const fixture = await createFixture(8 * 24 * 60 * 60);

    const result = runCleanup(fixture, [], ['--apply']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('no PR; unique content; preserving branch; inactive 8d');
    expect(result.stdout).toContain('Removed: 1');
    expect(runGit(['rev-parse', 'feature'], fixture.primaryWorktree)).toBe(fixture.candidateHead);
    await expect(access(fixture.candidateWorktree)).rejects.toThrow();
  });

  it('keeps an in-sync open PR worktree whose administrative activity is younger than 48 hours', async () => {
    const fixture = await createFixture(47 * 60 * 60);

    const result = runCleanup(fixture, [openPullRequest(fixture.candidateHead)]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('OPEN; inactive for 1d, minimum is 2d');
    expect(result.stdout).toContain('Eligible for removal: 0');
    expect(result.stdout).toContain('Skipped — too fresh:  1');
  });

  it('fails closed on dirty worktrees', async () => {
    const fixture = await createFixture(72 * 60 * 60);
    await writeFile(join(fixture.candidateWorktree, 'uncommitted.txt'), 'keep me\n', 'utf8');

    const result = runCleanup(fixture, [openPullRequest(fixture.candidateHead)]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('[feature] (1 uncommitted file(s))');
    expect(result.stdout).toContain('Eligible for removal: 0');
    expect(result.stdout).toContain('Skipped — dirty:      1');
  });

  it('never removes a worktree when a live process CWD is in a subdirectory', async () => {
    const fixture = await createFixture(8 * 24 * 60 * 60);
    const processDirectory = join(fixture.candidateWorktree, 'empty-process-directory');
    await mkdir(processDirectory);
    const liveProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: processDirectory,
      stdio: 'ignore',
    });

    try {
      const result = runCleanup(fixture, [], ['--apply']);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('a live process has its CWD in this worktree');
      expect(result.stdout).toContain('Eligible for removal: 0');
      expect(result.stdout).toContain('Skipped — in use:      1');
      expect(runGit(['worktree', 'list', '--porcelain'], fixture.primaryWorktree)).toContain(fixture.candidateWorktree);
    } finally {
      liveProcess.kill('SIGKILL');
    }
  });

  it('uses lsof CWD records when procfs is unavailable', async () => {
    const fixture = await createFixture(8 * 24 * 60 * 60);
    const lsofCountFile = join(dirname(fixture.primaryWorktree), 'lsof-count');
    await writeExecutable(
      join(fixture.stubBinDirectory, 'lsof'),
      '#!/bin/sh\n' +
        'count=0\n' +
        'if [ -f "$LSOF_COUNT_FILE" ]; then IFS= read -r count < "$LSOF_COUNT_FILE"; fi\n' +
        'printf "%s\\n" "$((count + 1))" > "$LSOF_COUNT_FILE"\n' +
        'printf "p12345\\nn%s/active-subdirectory\\n" "$LSOF_ACTIVE_WORKTREE"\n',
    );

    const result = runCleanup(fixture, [], ['--apply'], {
      LSOF_ACTIVE_WORKTREE: fixture.candidateWorktree,
      LSOF_COUNT_FILE: lsofCountFile,
      WORKTREE_CWD_PROC_ROOT_OVERRIDE: '/proc-not-mounted-for-test',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('a live process has its CWD in this worktree');
    expect(result.stdout).toContain('Eligible for removal: 0');
    expect(await readFile(lsofCountFile, 'utf8')).toBe('1\n');
    expect(runGit(['worktree', 'list', '--porcelain'], fixture.primaryWorktree)).toContain(fixture.candidateWorktree);
  });

  it('warns and fails closed when live process CWDs cannot be enumerated', async () => {
    const fixture = await createFixture(8 * 24 * 60 * 60);
    await writeExecutable(join(fixture.stubBinDirectory, 'lsof'), '#!/bin/sh\nexit 1\n');

    const result = runCleanup(fixture, [], ['--apply'], {
      WORKTREE_CWD_PROC_ROOT_OVERRIDE: '/proc-not-mounted-for-test',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('live process CWDs could not be enumerated');
    expect(result.stdout).toContain('Eligible for removal: 0');
    expect(result.stdout).toContain('Skipped — in use:      1');
  });

  it('never removes a Git-locked worktree', async () => {
    const fixture = await createFixture(8 * 24 * 60 * 60);
    runGit(['worktree', 'lock', '--reason', 'active agent', fixture.candidateWorktree], fixture.primaryWorktree);

    const result = runCleanup(fixture, [], ['--apply']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('worktree is locked');
    expect(result.stdout).toContain('Eligible for removal: 0');
    expect(result.stdout).toContain('Skipped — locked:      1');
    expect(runGit(['worktree', 'list', '--porcelain'], fixture.primaryWorktree)).toContain(fixture.candidateWorktree);
  });

  it('creates a recovery branch before removing stale detached unique content', async () => {
    const fixture = await createFixture(8 * 24 * 60 * 60);
    runGit(['switch', '--detach'], fixture.candidateWorktree);
    runGit(['branch', '-D', 'feature'], fixture.primaryWorktree);
    await setWorktreeInactivity(fixture.candidateWorktree, 8 * 24 * 60 * 60);

    const result = runCleanup(fixture, [], ['--apply']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('unique content will get a recovery branch');
    expect(result.stdout).toContain('preserved detached HEAD as recovery/worktree-feature-');
    const recoveryRef = runGit(
      ['for-each-ref', '--format=%(refname)', 'refs/heads/recovery/worktree-feature-*'],
      fixture.primaryWorktree,
    );
    expect(recoveryRef).toMatch(/^refs\/heads\/recovery\/worktree-feature-/);
    expect(runGit(['rev-parse', recoveryRef], fixture.primaryWorktree)).toBe(fixture.candidateHead);
    await expect(access(fixture.candidateWorktree)).rejects.toThrow();
  }, 15_000);

  it('preserves an unreachable detached commit even when its final tree matches main', async () => {
    const fixture = await createFixture(8 * 24 * 60 * 60);
    runGit(['rm', 'feature.txt'], fixture.candidateWorktree);
    const staleCommitTimestamp = Math.floor(Date.now() / 1000) - 8 * 24 * 60 * 60;
    runGit(
      ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'revert: return to main tree'],
      fixture.candidateWorktree,
      {
        GIT_AUTHOR_DATE: `@${staleCommitTimestamp} +0000`,
        GIT_COMMITTER_DATE: `@${staleCommitTimestamp} +0000`,
      },
    );
    const netZeroHead = runGit(['rev-parse', 'HEAD'], fixture.candidateWorktree);
    runGit(['switch', '--detach'], fixture.candidateWorktree);
    runGit(['branch', '-D', 'feature'], fixture.primaryWorktree);
    await setWorktreeInactivity(fixture.candidateWorktree, 8 * 24 * 60 * 60);

    const result = runCleanup(fixture, [], ['--apply']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('unique content will get a recovery branch');
    const recoveryRef = runGit(
      ['for-each-ref', '--format=%(refname)', 'refs/heads/recovery/worktree-feature-*'],
      fixture.primaryWorktree,
    );
    expect(runGit(['rev-parse', recoveryRef], fixture.primaryWorktree)).toBe(netZeroHead);
  }, 15_000);

  it('treats a recent commit as activity after its branch ref is packed', async () => {
    const fixture = await createFixture(30 * 24 * 60 * 60);
    runGit(
      ['-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'test: recent packed commit'],
      fixture.candidateWorktree,
    );
    runGit(['pack-refs', '--all'], fixture.primaryWorktree);
    const activityTimestamp = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const administrativeHead = runGit(
      ['rev-parse', '--path-format=absolute', '--git-path', 'HEAD'],
      fixture.candidateWorktree,
    );
    await utimes(administrativeHead, activityTimestamp, activityTimestamp);

    const result = runCleanup(fixture, []);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('no PR; inactive for 0h, minimum is 7d');
    expect(result.stdout).toContain('Eligible for removal: 0');
  });

  it('uses the 48-hour floor for clean Claude agent worktrees and preserves their branches', async () => {
    const fixture = await createFixture(49 * 60 * 60, '.claude/worktrees/feature');

    const result = runCleanup(fixture, [], ['--apply']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('no PR; unique content; preserving branch; inactive 2d');
    expect(result.stdout).toContain('Removed: 1');
    expect(runGit(['rev-parse', 'feature'], fixture.primaryWorktree)).toBe(fixture.candidateHead);
  }, 15_000);

  it('treats a closed unmerged PR like stale no-PR work and preserves its branch', async () => {
    const fixture = await createFixture(8 * 24 * 60 * 60);
    const closedPullRequest: PullRequest = {
      createdAt: '2026-03-01T00:00:00Z',
      headRefName: 'feature',
      headRefOid: fixture.candidateHead,
      isCrossRepository: false,
      mergeCommit: null,
      mergedAt: null,
      number: 43,
      state: 'CLOSED',
      url: 'https://github.com/boardsesh/boardsesh/pull/43',
    };

    const result = runCleanup(fixture, [mergedPullRequest(fixture.candidateHead), closedPullRequest], ['--apply']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('PR #43 closed without merge; preserving branch');
    expect(runGit(['rev-parse', 'feature'], fixture.primaryWorktree)).toBe(fixture.candidateHead);
  });

  it('prefers a PR whose head OID matches when a branch name was reused', async () => {
    const fixture = await createFixture(30 * 60 * 60);
    const newerOpenPullRequest = openPullRequest('0000000000000000000000000000000000000000');
    newerOpenPullRequest.createdAt = '2026-04-01T00:00:00Z';

    const result = runCleanup(fixture, [mergedPullRequest(fixture.candidateHead), newerOpenPullRequest], ['--apply']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('PR #41 merged; inactive 1d');
    expect(result.stdout).toContain('Removed: 1');
    expect(runGit(['rev-parse', 'feature'], fixture.primaryWorktree)).toBe(fixture.candidateHead);
  });

  it('warns when the bounded PR metadata window is full', async () => {
    const fixture = await createFixture(24 * 60 * 60);
    const result = runCleanup(fixture, [], [], { GH_PR_COUNT: '1000' });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      'only the newest 1000 PRs were loaded; older unmatched branches will use the conservative no-PR policy',
    );
    expect(result.stdout).toContain('no PR; inactive for 1d, minimum is 7d');
  });

  it('revalidates HEAD for a no-PR candidate immediately before applying removal', async () => {
    const fixture = await createFixture(8 * 24 * 60 * 60);
    const mutationCountPath = join(dirname(fixture.primaryWorktree), 'git-mutation-count');

    const result = runCleanup(fixture, [], ['--apply'], {
      GIT_MUTATE_COUNT_FILE: mutationCountPath,
      GIT_MUTATE_WORKTREE: fixture.candidateWorktree,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Eligible for removal: 1');
    expect(result.stdout).toContain('worktree changed after eligibility scan');
    expect(result.stdout).toContain('Removed: 0');
    expect(result.stdout).toContain('Skipped after scan: 1');
    const advancedHead = runGit(['rev-parse', 'HEAD'], fixture.candidateWorktree);
    expect(advancedHead).not.toBe(fixture.candidateHead);
    expect(runGit(['rev-parse', 'feature'], fixture.primaryWorktree)).toBe(advancedHead);
  });

  it('revalidates cleanliness for every candidate immediately before applying removal', async () => {
    const fixture = await createFixture(8 * 24 * 60 * 60);
    const statusCountPath = join(dirname(fixture.primaryWorktree), 'git-status-count');

    const result = runCleanup(fixture, [], ['--apply'], {
      GIT_DIRTY_ON_STATUS_COUNT_FILE: statusCountPath,
      GIT_MUTATE_WORKTREE: fixture.candidateWorktree,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Eligible for removal: 1');
    expect(result.stdout).toContain('worktree changed after eligibility scan');
    expect(result.stdout).toContain('Removed: 0');
    expect(result.stdout).toContain('Skipped after scan: 1');
    await expect(access(join(fixture.candidateWorktree, 'apply-dirty.txt'))).resolves.toBeUndefined();
  });
});
