/// <reference types="node" />

import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, onTestFinished } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repairScript = join(repositoryRoot, 'scripts/configure-git-hooks.sh');

type Fixture = {
  commitMessageLogPath: string;
  primaryWorktree: string;
  rootDirectory: string;
  stubBinDirectory: string;
  vpLogPath: string;
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
  const rootDirectory = await realpath(await mkdtemp(join(tmpdir(), 'boardsesh-hook-repair-')));
  onTestFinished(() => rm(rootDirectory, { force: true, recursive: true }));
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
  await mkdir(join(primaryWorktree, 'scripts'), { recursive: true });
  await mkdir(join(primaryWorktree, 'node_modules/.bin'), { recursive: true });
  await mkdir(stubBinDirectory, { recursive: true });

  await cp(join(repositoryRoot, '.vite-hooks/pre-commit'), join(primaryWorktree, '.vite-hooks/pre-commit'));
  await cp(join(repositoryRoot, '.vite-hooks/post-checkout'), join(primaryWorktree, '.vite-hooks/post-checkout'));
  await cp(join(repositoryRoot, '.vite-hooks/commit-msg'), join(primaryWorktree, '.vite-hooks/commit-msg'));
  await cp(join(repositoryRoot, '.githooks/commit-msg'), join(primaryWorktree, '.githooks/commit-msg'));
  await cp(repairScript, join(primaryWorktree, 'scripts/configure-git-hooks.sh'));
  await Promise.all([
    chmod(join(primaryWorktree, '.vite-hooks/pre-commit'), 0o755),
    chmod(join(primaryWorktree, '.vite-hooks/post-checkout'), 0o755),
    chmod(join(primaryWorktree, '.vite-hooks/commit-msg'), 0o755),
    chmod(join(primaryWorktree, '.githooks/commit-msg'), 0o755),
    chmod(join(primaryWorktree, 'scripts/configure-git-hooks.sh'), 0o755),
  ]);

  await writeExecutable(
    join(stubBinDirectory, 'vp'),
    '#!/bin/sh\nprintf "%s:%s\\n" "$1" "$PWD" >> "$VP_LOG"\nif [ "$1" = install ]; then\n  git config --local --replace-all core.hooksPath .vite-hooks/_\nfi\n',
  );
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

function executableCommandLineIndexes(contents: string, command: string): number[] {
  return contents.split('\n').reduce<number[]>((indexes, line, index) => {
    const trimmedLine = line.trim();
    if (!trimmedLine.startsWith('#') && trimmedLine === command) {
      indexes.push(index);
    }
    return indexes;
  }, []);
}

function expectCommandAfter(contents: string, firstCommand: string, secondCommand: string): void {
  const firstCommandIndexes = executableCommandLineIndexes(contents, firstCommand);
  const secondCommandIndexes = executableCommandLineIndexes(contents, secondCommand);

  expect(firstCommandIndexes.length, `missing exact command line: ${firstCommand}`).toBeGreaterThan(0);
  expect(secondCommandIndexes.length, `missing exact command line: ${secondCommand}`).toBeGreaterThan(0);
  expect(Math.min(...secondCommandIndexes)).toBeGreaterThan(Math.max(...firstCommandIndexes));
}

describe('configure-git-hooks', () => {
  it.each(['', '.vite-hooks/_', '.vite-hooks'])('repairs the allowed effective hook path %j', async (initialPath) => {
    const fixture = await createFixture();
    runGit(['config', '--local', 'core.hooksPath', initialPath], fixture.primaryWorktree);

    const result = repairHooks(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(runGit(['config', '--local', '--get', 'core.hooksPath'], fixture.primaryWorktree)).toBe('.vite-hooks');
    expect(runGit(['config', '--get', 'core.hooksPath'], fixture.primaryWorktree)).toBe('.vite-hooks');
  });

  it('repairs Vite+ installs so subsequent linked worktrees keep executing tracked hooks', async () => {
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
    expect(runGit(['config', '--local', '--get', 'core.hooksPath'], linkedWorktree)).toBe('.vite-hooks');

    // The first worktree's fake `vp install` resets the shared repository config
    // to .vite-hooks/_. If post-checkout did not repair it, Git would look for the
    // second worktree's not-yet-generated `_` hooks and this install would never
    // run. Creating two worktrees proves the tracked hook path survives the first.
    const subsequentWorktree = join(fixture.rootDirectory, 'subsequent');
    const subsequentWorktreeResult = run(
      'git',
      ['worktree', 'add', '-b', 'subsequent-worktree', subsequentWorktree],
      fixture.primaryWorktree,
      hookEnvironment,
    );

    expect(subsequentWorktreeResult.status, subsequentWorktreeResult.stderr).toBe(0);
    expect(await readFile(fixture.vpLogPath, 'utf8')).toContain(`install:${subsequentWorktree}`);
    expect(runGit(['config', '--local', '--get', 'core.hooksPath'], subsequentWorktree)).toBe('.vite-hooks');

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

    const subsequentInvalidCommitResult = run(
      'git',
      ['commit', '--allow-empty', '-m', 'invalid subsequent commit message'],
      subsequentWorktree,
      hookEnvironment,
    );

    expect(subsequentInvalidCommitResult.status).not.toBe(0);
    expect(subsequentInvalidCommitResult.stderr).toContain('invalid Conventional Commit');
    expect(await readFile(fixture.vpLogPath, 'utf8')).toContain(`staged:${subsequentWorktree}`);
    expect((await readFile(fixture.commitMessageLogPath, 'utf8')).trim().split('\n')).toEqual([
      fixture.primaryWorktree,
      linkedWorktree,
      subsequentWorktree,
    ]);
    expect(runGit(['config', '--get', 'core.hooksPath'], subsequentWorktree)).toBe('.vite-hooks');
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

  it('normalizes an allowed worktree-level hook override', async () => {
    const fixture = await createFixture();
    runGit(['config', 'extensions.worktreeConfig', 'true'], fixture.primaryWorktree);
    runGit(['config', '--worktree', '--replace-all', 'core.hooksPath', '.vite-hooks/_'], fixture.primaryWorktree);

    const result = repairHooks(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(runGit(['config', '--worktree', '--get', 'core.hooksPath'], fixture.primaryWorktree)).toBe('.vite-hooks');
    expect(runGit(['config', '--get', 'core.hooksPath'], fixture.primaryWorktree)).toBe('.vite-hooks');
  });

  it('refuses a foreign worktree-level hook override without replacing it', async () => {
    const fixture = await createFixture();
    runGit(['config', 'extensions.worktreeConfig', 'true'], fixture.primaryWorktree);
    runGit(['config', '--worktree', '--replace-all', 'core.hooksPath', '.custom-hooks'], fixture.primaryWorktree);

    const result = repairHooks(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("core.hooksPath is '.custom-hooks'");
    expect(runGit(['config', '--worktree', '--get', 'core.hooksPath'], fixture.primaryWorktree)).toBe('.custom-hooks');
  });

  it('fails when a required tracked Vite+ hook is missing', async () => {
    const fixture = await createFixture();
    const missingHookPath = join(fixture.primaryWorktree, '.vite-hooks/pre-commit');
    await rm(missingHookPath);

    const result = repairHooks(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`expected executable hook is missing: ${missingHookPath}`);
  });

  it('fails when the Conventional Commit hook is missing', async () => {
    const fixture = await createFixture();
    const missingHookPath = join(fixture.primaryWorktree, '.githooks/commit-msg');
    await rm(missingHookPath);

    const result = repairHooks(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`expected executable Conventional Commit hook is missing: ${missingHookPath}`);
  });

  it('fails with a clear message outside a Git worktree', async () => {
    const fixture = await createFixture();

    const result = run('sh', [repairScript], fixture.rootDirectory);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('run this command from inside a Git worktree');
  });

  it('warns without failing when post-checkout cannot repair hooks', async () => {
    const fixture = await createFixture();
    await rm(join(fixture.primaryWorktree, 'scripts/configure-git-hooks.sh'));

    const result = run(
      'sh',
      [join(fixture.primaryWorktree, '.vite-hooks/post-checkout'), 'previous-head', 'new-head', '1'],
      fixture.primaryWorktree,
      {
        PATH: `${fixture.stubBinDirectory}:${process.env.PATH ?? ''}`,
        VP_LOG: fixture.vpLogPath,
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('WARNING: Dependencies installed, but Git hooks could not be repaired');
  });

  it('runs the repair after Vite+ has completed every hook-affecting setup step', async () => {
    const claudeSetup = await readFile(join(repositoryRoot, '.claude/setup.sh'), 'utf8');
    const developerSetup = await readFile(join(repositoryRoot, 'scripts/setup-dev.sh'), 'utf8');
    const postCheckoutHook = await readFile(join(repositoryRoot, '.vite-hooks/post-checkout'), 'utf8');

    expectCommandAfter(claudeSetup, 'vp config', './scripts/configure-git-hooks.sh');
    expectCommandAfter(developerSetup, 'if ! vp install; then', 'vp config');
    expectCommandAfter(developerSetup, 'vp config', 'if ! "$REPO_ROOT/scripts/configure-git-hooks.sh"; then');
    expectCommandAfter(
      postCheckoutHook,
      'if ! vp install; then',
      'if ! "$repo_root/scripts/configure-git-hooks.sh"; then',
    );
  });
});
