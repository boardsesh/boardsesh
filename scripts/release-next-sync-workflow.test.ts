/// <reference types="node" />

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { parse } from 'yaml';

type WorkflowStep = { name?: string; run?: string };
type FixtureKind =
  | 'linear'
  | 'merge-history'
  | 'main-merge-history'
  | 'conflict'
  | 'conflict-special-path'
  | 'conflict-delete';
type Fixture = {
  conflictPath: string;
  mainSha: string;
  originRepository: string;
  releaseSha: string;
  runnerTemp: string;
  worktree: string;
};
type EnvironmentOverrides = Record<string, string | undefined>;

const workflowSource = readFileSync('.github/workflows/release-next-sync.yml', 'utf8');
const workflow = parse(workflowSource) as { jobs: { rebase: { steps: WorkflowStep[] } } };

function scriptFor(stepName: string): string {
  const script = workflow.jobs.rebase.steps.find((step) => step.name === stepName)?.run;
  if (!script) throw new Error(`Workflow step has no shell script: ${stepName}`);
  return script;
}

const updateScript = scriptFor('Update release/next to current main');
const finalizeScript = scriptFor("Stage and commit Claude's conflict resolution");
const verifyScript = scriptFor('Verify the completed update');

function run(
  command: string,
  args: string[],
  cwd: string,
  environmentOverrides: EnvironmentOverrides = {},
): SpawnSyncReturns<string> {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      ...environmentOverrides,
    },
  });
}

function runGit(args: string[], cwd: string): string {
  const result = run('git', args, cwd);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${result.stderr}`);
  return result.stdout.trim();
}

function commitAll(worktree: string, message: string): void {
  runGit(['add', '.'], worktree);
  runGit(['-c', 'core.hooksPath=/dev/null', 'commit', '-m', message], worktree);
}

function createFixture(kind: FixtureKind): Fixture {
  const rootDirectory = mkdtempSync(join(tmpdir(), 'release-next-sync-'));
  onTestFinished(() => rmSync(rootDirectory, { force: true, recursive: true }));
  const originRepository = join(rootDirectory, 'origin.git');
  const worktree = join(rootDirectory, 'worktree');
  const runnerTemp = join(rootDirectory, 'runner-temp');
  mkdirSync(runnerTemp);

  expect(run('git', ['init', '--bare', originRepository], rootDirectory).status).toBe(0);
  expect(run('git', ['clone', originRepository, worktree], rootDirectory).status).toBe(0);
  runGit(['config', 'user.name', 'Release Sync Test'], worktree);
  runGit(['config', 'user.email', 'release-sync@example.com'], worktree);
  runGit(['config', 'core.hooksPath', '/dev/null'], worktree);
  runGit(['checkout', '-b', 'main'], worktree);
  const conflictPath = kind === 'conflict-special-path' ? 'conflict\nfile\tname.txt' : 'conflict.txt';
  writeFileSync(join(worktree, conflictPath), 'base\n', 'utf8');
  writeFileSync(join(worktree, 'stable.txt'), 'stable\n', 'utf8');
  commitAll(worktree, 'chore: seed fixture');
  runGit(['push', '-u', 'origin', 'main'], worktree);

  runGit(['checkout', '-b', 'release/next'], worktree);
  if (kind.startsWith('conflict')) {
    writeFileSync(join(worktree, conflictPath), 'release\n', 'utf8');
    commitAll(worktree, 'feat: change release value');
  } else if (kind === 'merge-history') {
    runGit(['checkout', '-b', 'release-feature'], worktree);
    writeFileSync(join(worktree, 'release-feature.txt'), 'release merge\n', 'utf8');
    commitAll(worktree, 'feat: add merged release work');
    runGit(['checkout', 'release/next'], worktree);
    runGit(['merge', '--no-ff', '-m', 'merge: release feature', 'release-feature'], worktree);
  } else {
    writeFileSync(join(worktree, 'release-linear.txt'), 'release linear\n', 'utf8');
    commitAll(worktree, 'feat: add linear release work');
  }
  const releaseSha = runGit(['rev-parse', 'HEAD'], worktree);
  runGit(['push', '-u', 'origin', 'release/next'], worktree);

  runGit(['checkout', 'main'], worktree);
  if (kind === 'conflict-delete') {
    unlinkSync(join(worktree, conflictPath));
  } else if (kind.startsWith('conflict')) {
    writeFileSync(join(worktree, conflictPath), 'main\n', 'utf8');
  } else if (kind === 'main-merge-history') {
    runGit(['checkout', '-b', 'main-feature'], worktree);
    writeFileSync(join(worktree, 'main-merge.txt'), 'main merge\n', 'utf8');
    commitAll(worktree, 'feat: add merged main work');
    runGit(['checkout', 'main'], worktree);
    runGit(['merge', '--no-ff', '-m', 'merge: main feature', 'main-feature'], worktree);
  } else {
    writeFileSync(join(worktree, 'main-change.txt'), 'main change\n', 'utf8');
  }
  if (kind !== 'main-merge-history') commitAll(worktree, 'feat: advance main');
  const mainSha = runGit(['rev-parse', 'HEAD'], worktree);
  runGit(['push', 'origin', 'main'], worktree);
  runGit(['checkout', 'release/next'], worktree);
  return { conflictPath, mainSha, originRepository, releaseSha, runnerTemp, worktree };
}

function atomicPush(fixture: Fixture): SpawnSyncReturns<string> {
  return run(
    'git',
    [
      'push',
      '--atomic',
      `--force-with-lease=refs/heads/release/next:${fixture.releaseSha}`,
      `--force-with-lease=refs/heads/main:${fixture.mainSha}`,
      'origin',
      'HEAD:refs/heads/release/next',
      `${fixture.mainSha}:refs/heads/main`,
    ],
    fixture.worktree,
  );
}

function remoteSha(fixture: Fixture, ref: string): string {
  return runGit(['ls-remote', 'origin', ref], fixture.worktree).split('\t')[0];
}

function runWorkflowScript(
  script: string,
  fixture: Fixture,
  outputName: string,
  environmentOverrides: EnvironmentOverrides = {},
): SpawnSyncReturns<string> {
  return run('bash', ['-c', script], fixture.worktree, {
    EXPECTED_MAIN_SHA: fixture.mainSha,
    EXPECTED_RELEASE_SHA: fixture.releaseSha,
    GITHUB_OUTPUT: join(fixture.runnerTemp, outputName),
    RUNNER_TEMP: fixture.runnerTemp,
    ...environmentOverrides,
  });
}

function outputValues(fixture: Fixture, outputName: string, key: string): string[] {
  return readFileSync(join(fixture.runnerTemp, outputName), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));
}

describe('release/next sync workflow shell behavior', () => {
  it('rebases a linear release range', () => {
    const fixture = createFixture('linear');
    const result = runWorkflowScript(updateScript, fixture, 'update-output.txt');

    expect(result.status, result.stderr).toBe(0);
    expect(outputValues(fixture, 'update-output.txt', 'strategy')).toEqual(['rebase']);
    expect(outputValues(fixture, 'update-output.txt', 'conflicted')).toEqual(['false']);
    expect(run('git', ['merge-base', '--is-ancestor', fixture.mainSha, 'HEAD'], fixture.worktree).status).toBe(0);
    expect(run('git', ['merge-base', '--is-ancestor', fixture.releaseSha, 'HEAD'], fixture.worktree).status).toBe(1);
  });

  it('creates a merge commit when the release-only range owns merge history', () => {
    const fixture = createFixture('merge-history');
    const result = runWorkflowScript(updateScript, fixture, 'update-output.txt');

    expect(result.status, result.stderr).toBe(0);
    expect(outputValues(fixture, 'update-output.txt', 'strategy')).toEqual(['merge']);
    expect(outputValues(fixture, 'update-output.txt', 'conflicted')).toEqual(['false']);
    expect(runGit(['rev-parse', 'HEAD^1'], fixture.worktree)).toBe(fixture.releaseSha);
    expect(runGit(['rev-parse', 'HEAD^2'], fixture.worktree)).toBe(fixture.mainSha);
  });

  it('still rebases when only main owns merge history', () => {
    const fixture = createFixture('main-merge-history');
    const result = runWorkflowScript(updateScript, fixture, 'update-output.txt');

    expect(result.status, result.stderr).toBe(0);
    expect(outputValues(fixture, 'update-output.txt', 'strategy')).toEqual(['rebase']);
    expect(outputValues(fixture, 'update-output.txt', 'conflicted')).toEqual(['false']);
    expect(run('git', ['merge-base', '--is-ancestor', fixture.mainSha, 'HEAD'], fixture.worktree).status).toBe(0);
    expect(run('git', ['merge-base', '--is-ancestor', fixture.releaseSha, 'HEAD'], fixture.worktree).status).toBe(1);
  });

  it('atomically pushes the update while both leases still match', () => {
    const fixture = createFixture('linear');
    const updateResult = runWorkflowScript(updateScript, fixture, 'update-output.txt');
    expect(updateResult.status, updateResult.stderr).toBe(0);
    const updatedReleaseSha = runGit(['rev-parse', 'HEAD'], fixture.worktree);

    const pushResult = atomicPush(fixture);

    expect(pushResult.status, pushResult.stderr).toBe(0);
    expect(remoteSha(fixture, 'refs/heads/release/next')).toBe(updatedReleaseSha);
    expect(remoteSha(fixture, 'refs/heads/main')).toBe(fixture.mainSha);
  });

  it('leaves release/next untouched when main moves during the update', () => {
    const fixture = createFixture('linear');
    const updateResult = runWorkflowScript(updateScript, fixture, 'update-output.txt');
    expect(updateResult.status, updateResult.stderr).toBe(0);
    const raceWorktree = join(fixture.runnerTemp, 'main-race-worktree');
    expect(run('git', ['clone', fixture.originRepository, raceWorktree], fixture.runnerTemp).status).toBe(0);
    runGit(['config', 'user.name', 'Release Sync Race Test'], raceWorktree);
    runGit(['config', 'user.email', 'release-sync-race@example.com'], raceWorktree);
    runGit(['config', 'core.hooksPath', '/dev/null'], raceWorktree);
    runGit(['checkout', 'main'], raceWorktree);
    writeFileSync(join(raceWorktree, 'racing-main-change.txt'), 'new main tip\n', 'utf8');
    commitAll(raceWorktree, 'feat: race the release sync');
    const racedMainSha = runGit(['rev-parse', 'HEAD'], raceWorktree);
    runGit(['push', 'origin', 'main'], raceWorktree);

    const pushResult = atomicPush(fixture);

    expect(pushResult.status).not.toBe(0);
    expect(remoteSha(fixture, 'refs/heads/release/next')).toBe(fixture.releaseSha);
    expect(remoteSha(fixture, 'refs/heads/main')).toBe(racedMainSha);
  });

  it('falls back from a conflicting rebase and commits a scoped merge resolution', () => {
    const fixture = createFixture('conflict');
    const updateResult = runWorkflowScript(updateScript, fixture, 'update-output.txt');

    expect(updateResult.status, updateResult.stderr).toBe(0);
    expect(outputValues(fixture, 'update-output.txt', 'strategy')).toEqual(['rebase', 'merge']);
    expect(outputValues(fixture, 'update-output.txt', 'conflicted')).toEqual(['true']);
    expect(runGit(['rev-parse', 'MERGE_HEAD'], fixture.worktree)).toBe(fixture.mainSha);
    expect(readFileSync(join(fixture.runnerTemp, 'release-next-conflicts.txt'))).toEqual(
      Buffer.from(`${fixture.conflictPath}\0`),
    );

    writeFileSync(join(fixture.worktree, fixture.conflictPath), 'main\nrelease\n', 'utf8');
    const finalizeResult = runWorkflowScript(finalizeScript, fixture, 'finalize-output.txt');
    expect(finalizeResult.status, finalizeResult.stderr).toBe(0);
    expect(runGit(['rev-parse', 'HEAD^1'], fixture.worktree)).toBe(fixture.releaseSha);
    expect(runGit(['rev-parse', 'HEAD^2'], fixture.worktree)).toBe(fixture.mainSha);

    const verifyResult = runWorkflowScript(verifyScript, fixture, 'verify-output.txt', {
      UPDATE_STRATEGY: 'merge',
    });
    expect(verifyResult.status, verifyResult.stderr).toBe(0);
    expect(outputValues(fixture, 'verify-output.txt', 'updated_sha')).toEqual([
      runGit(['rev-parse', 'HEAD'], fixture.worktree),
    ]);
  });

  it('rejects a conflict agent that edits a non-conflict path', () => {
    const fixture = createFixture('conflict');
    const updateResult = runWorkflowScript(updateScript, fixture, 'update-output.txt');
    expect(updateResult.status, updateResult.stderr).toBe(0);

    writeFileSync(join(fixture.worktree, fixture.conflictPath), 'main\nrelease\n', 'utf8');
    writeFileSync(join(fixture.worktree, 'stable.txt'), 'changed outside conflict\n', 'utf8');
    const finalizeResult = runWorkflowScript(finalizeScript, fixture, 'finalize-output.txt');

    expect(finalizeResult.status).toBe(1);
    expect(readFileSync(join(fixture.runnerTemp, 'release-next-sync-error.txt'), 'utf8')).toContain('stable.txt');
    expect(runGit(['rev-parse', 'HEAD'], fixture.worktree)).toBe(fixture.releaseSha);
  });

  it('rejects a conflict agent that stages a non-conflict path', () => {
    const fixture = createFixture('conflict');
    const updateResult = runWorkflowScript(updateScript, fixture, 'update-output.txt');
    expect(updateResult.status, updateResult.stderr).toBe(0);

    writeFileSync(join(fixture.worktree, fixture.conflictPath), 'main\nrelease\n', 'utf8');
    writeFileSync(join(fixture.worktree, 'stable.txt'), 'staged outside conflict\n', 'utf8');
    runGit(['add', 'stable.txt'], fixture.worktree);
    const finalizeResult = runWorkflowScript(finalizeScript, fixture, 'finalize-output.txt');

    expect(finalizeResult.status).toBe(1);
    expect(readFileSync(join(fixture.runnerTemp, 'release-next-sync-error.txt'), 'utf8')).toContain(
      'changed the Git index',
    );
    expect(runGit(['rev-parse', 'HEAD'], fixture.worktree)).toBe(fixture.releaseSha);
  });

  it('handles a conflicted pathname containing tabs and newlines', () => {
    const fixture = createFixture('conflict-special-path');
    const updateResult = runWorkflowScript(updateScript, fixture, 'update-output.txt');
    expect(updateResult.status, updateResult.stderr).toBe(0);

    expect(readFileSync(join(fixture.runnerTemp, 'release-next-conflicts.txt'))).toEqual(
      Buffer.from(`${fixture.conflictPath}\0`),
    );
    writeFileSync(join(fixture.worktree, fixture.conflictPath), 'main\nrelease\n', 'utf8');
    const finalizeResult = runWorkflowScript(finalizeScript, fixture, 'finalize-output.txt');

    expect(finalizeResult.status, finalizeResult.stderr).toBe(0);
    expect(runGit(['rev-parse', 'HEAD^1'], fixture.worktree)).toBe(fixture.releaseSha);
    expect(runGit(['rev-parse', 'HEAD^2'], fixture.worktree)).toBe(fixture.mainSha);
  });

  it('can accept deletion as the conflict resolution', () => {
    const fixture = createFixture('conflict-delete');
    const updateResult = runWorkflowScript(updateScript, fixture, 'update-output.txt');
    expect(updateResult.status, updateResult.stderr).toBe(0);

    rmSync(join(fixture.worktree, fixture.conflictPath));
    const finalizeResult = runWorkflowScript(finalizeScript, fixture, 'finalize-output.txt');

    expect(finalizeResult.status, finalizeResult.stderr).toBe(0);
    expect(runGit(['rev-parse', 'HEAD^1'], fixture.worktree)).toBe(fixture.releaseSha);
    expect(runGit(['rev-parse', 'HEAD^2'], fixture.worktree)).toBe(fixture.mainSha);
  });
});
