/// <reference types="node" />

import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repairScript = join(repositoryRoot, 'scripts/configure-git-hooks.sh');

type Fixture = {
  commitMessageLogPath: string;
  primaryWorktree: string;
  rootDirectory: string;
  stubBinDirectory: string;
  vpLogPath: string;
};

const fixtureDirectories: string[] = [];

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

function runGit(args: string[], cwd: string): string {
  const result = run('git', args, cwd);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, 'utf8');
  await chmod(path, 0o755);
}

async function createFixture(): Promise<Fixture> {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'boardsesh-hook-repair-'));
  fixtureDirectories.push(rootDirectory);
  const bareRepository = join(rootDirectory, 'origin.git');
  const primaryWorktree = join(rootDirectory, 'primary');
  const stubBinDirectory = join(rootDirectory, 'stub-bin');
  const commitMessageLogPath = join(rootDirectory, 'commit-msg.log');
  const vpLogPath = join(rootDirectory, 'vp.log');

  execFileSync('git', ['init', '--bare', bareRepository], { stdio: 'ignore' });
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'clone', bareRepository, primaryWorktree], {
    stdio: 'ignore',
  });
  runGit(['config', 'user.email', 'hooks@example.com'], primaryWorktree);
  runGit(['config', 'user.name', 'Hook Fixture'], primaryWorktree);

  await mkdir(join(primaryWorktree, '.vite-hooks'), { recursive: true });
  await mkdir(join(primaryWorktree, '.githooks'), { recursive: true });
  await mkdir(join(primaryWorktree, 'node_modules/.bin'), { recursive: true });
  await mkdir(stubBinDirectory, { recursive: true });

  await cp(join(repositoryRoot, '.vite-hooks/pre-commit'), join(primaryWorktree, '.vite-hooks/pre-commit'));
  await cp(join(repositoryRoot, '.vite-hooks/post-checkout'), join(primaryWorktree, '.vite-hooks/post-checkout'));
  await cp(join(repositoryRoot, '.vite-hooks/commit-msg'), join(primaryWorktree, '.vite-hooks/commit-msg'));
  await cp(join(repositoryRoot, '.githooks/commit-msg'), join(primaryWorktree, '.githooks/commit-msg'));
  await Promise.all([
    chmod(join(primaryWorktree, '.vite-hooks/pre-commit'), 0o755),
    chmod(join(primaryWorktree, '.vite-hooks/post-checkout'), 0o755),
    chmod(join(primaryWorktree, '.vite-hooks/commit-msg'), 0o755),
    chmod(join(primaryWorktree, '.githooks/commit-msg'), 0o755),
  ]);

  await writeExecutable(join(stubBinDirectory, 'vp'), '#!/bin/sh\nprintf "%s:%s\\n" "$1" "$PWD" >> "$VP_LOG"\n');
  await writeExecutable(
    join(primaryWorktree, 'node_modules/.bin/tsx'),
    '#!/bin/sh\nprintf "%s\\n" "$PWD" >> "$COMMIT_MSG_LOG"\nif grep -q "^invalid" "$2"; then\n  echo "invalid Conventional Commit" >&2\n  exit 1\nfi\n',
  );
  await writeFile(join(primaryWorktree, 'README.md'), '# fixture\n', 'utf8');

  runGit(['add', '.'], primaryWorktree);
  runGit(['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'chore: seed hook fixture'], primaryWorktree);

  return { commitMessageLogPath, primaryWorktree, rootDirectory, stubBinDirectory, vpLogPath };
}

function repairHooks(fixture: Fixture) {
  return run('sh', [repairScript], fixture.primaryWorktree, {
    PATH: `${fixture.stubBinDirectory}:${process.env.PATH ?? ''}`,
    VP_LOG: fixture.vpLogPath,
  });
}

afterEach(async () => {
  await Promise.all(fixtureDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('configure-git-hooks', () => {
  it.each(['', '.vite-hooks/_', '.vite-hooks'])('repairs the allowed effective hook path %j', async (initialPath) => {
    const fixture = await createFixture();
    runGit(['config', '--local', 'core.hooksPath', initialPath], fixture.primaryWorktree);

    const result = repairHooks(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(runGit(['config', '--local', '--get', 'core.hooksPath'], fixture.primaryWorktree)).toBe('.vite-hooks');
    expect(runGit(['config', '--get', 'core.hooksPath'], fixture.primaryWorktree)).toBe('.vite-hooks');
  });

  it('uses the tracked hooks from each linked worktree and rejects invalid commit messages', async () => {
    const fixture = await createFixture();
    const repairResult = repairHooks(fixture);
    expect(repairResult.status, repairResult.stderr).toBe(0);

    const linkedWorktree = join(fixture.rootDirectory, 'linked');
    const hookEnvironment = {
      COMMIT_MSG_LOG: fixture.commitMessageLogPath,
      PATH: `${fixture.stubBinDirectory}:${process.env.PATH ?? ''}`,
      VP_LOG: fixture.vpLogPath,
    };
    const worktreeResult = run(
      'git',
      ['worktree', 'add', '-b', 'linked-worktree', linkedWorktree],
      fixture.primaryWorktree,
      hookEnvironment,
    );

    expect(worktreeResult.status, worktreeResult.stderr).toBe(0);
    expect(await readFile(fixture.vpLogPath, 'utf8')).toContain(`install:${linkedWorktree}`);

    const invalidCommitResult = run(
      'git',
      ['commit', '--allow-empty', '-m', 'invalid commit message'],
      fixture.primaryWorktree,
      hookEnvironment,
    );

    expect(invalidCommitResult.status).not.toBe(0);
    expect(invalidCommitResult.stderr).toContain('invalid Conventional Commit');
    expect(await readFile(fixture.vpLogPath, 'utf8')).toContain(`staged:${fixture.primaryWorktree}`);

    const linkedInvalidCommitResult = run(
      'git',
      ['commit', '--allow-empty', '-m', 'invalid linked commit message'],
      linkedWorktree,
      hookEnvironment,
    );

    expect(linkedInvalidCommitResult.status).not.toBe(0);
    expect(linkedInvalidCommitResult.stderr).toContain('invalid Conventional Commit');
    expect(await readFile(fixture.vpLogPath, 'utf8')).toContain(`staged:${linkedWorktree}`);
    expect((await readFile(fixture.commitMessageLogPath, 'utf8')).trim().split('\n')).toEqual([
      fixture.primaryWorktree,
      linkedWorktree,
    ]);
    expect(runGit(['config', '--get', 'core.hooksPath'], linkedWorktree)).toBe('.vite-hooks');
  });

  it('refuses a foreign effective hook path without replacing it', async () => {
    const fixture = await createFixture();
    runGit(['config', '--local', 'core.hooksPath', '.custom-hooks'], fixture.primaryWorktree);

    const result = repairHooks(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("core.hooksPath is '.custom-hooks'");
    expect(result.stderr).toContain('Refusing to replace a custom hook path');
    expect(runGit(['config', '--get', 'core.hooksPath'], fixture.primaryWorktree)).toBe('.custom-hooks');
  });

  it('refuses a hidden foreign local hook path too', async () => {
    const fixture = await createFixture();
    runGit(['config', '--local', '--add', 'core.hooksPath', '.custom-hooks'], fixture.primaryWorktree);
    runGit(['config', '--local', '--add', 'core.hooksPath', '.vite-hooks'], fixture.primaryWorktree);

    const result = repairHooks(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("local core.hooksPath is '.custom-hooks'");
    expect(runGit(['config', '--local', '--get-all', 'core.hooksPath'], fixture.primaryWorktree)).toBe(
      '.custom-hooks\n.vite-hooks',
    );
  });

  it('normalizes repeated Boardsesh-managed local values', async () => {
    const fixture = await createFixture();
    runGit(['config', '--local', '--add', 'core.hooksPath', '.vite-hooks/_'], fixture.primaryWorktree);
    runGit(['config', '--local', '--add', 'core.hooksPath', '.vite-hooks'], fixture.primaryWorktree);

    const result = repairHooks(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(runGit(['config', '--local', '--get-all', 'core.hooksPath'], fixture.primaryWorktree)).toBe('.vite-hooks');
  });

  it('runs the repair after Vite+ has completed every hook-affecting setup step', async () => {
    const claudeSetup = await readFile(join(repositoryRoot, '.claude/setup.sh'), 'utf8');
    const developerSetup = await readFile(join(repositoryRoot, 'scripts/setup-dev.sh'), 'utf8');

    expect(claudeSetup).toContain('vp config\n./scripts/configure-git-hooks.sh');
    expect(developerSetup.indexOf('vp install')).toBeLessThan(developerSetup.indexOf('vp config'));
    expect(developerSetup).toContain('vp config\n"$REPO_ROOT/scripts/configure-git-hooks.sh"');
  });
});
