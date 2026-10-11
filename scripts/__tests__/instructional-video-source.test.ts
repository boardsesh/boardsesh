import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertTutorialReleaseClean, tutorialModifiedSourcePaths } from '../lib/instructional-video/source';

const temporaryRepositories: string[] = [];
const git = (directory: string, args: readonly string[]): string =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();

function writeSource(directory: string, path: string, content = 'export const revision = 1;\n'): void {
  const destination = resolve(directory, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

function sourceRepository(): string {
  const directory = mkdtempSync(resolve(tmpdir(), 'boardsesh-tutorial-source-'));
  temporaryRepositories.push(directory);
  git(directory, ['init', '--quiet']);
  git(directory, ['config', 'user.name', 'Tutorial source test']);
  git(directory, ['config', 'user.email', 'tutorial-source@example.invalid']);
  for (const path of [
    'packages/mobile/src/screen.ts',
    'packages/backend/src/auth.ts',
    'packages/shared/queue/src/state.ts',
    'scripts/instructional-video.ts',
    'packages/backend/src/scripts/seed-instructional-video.ts',
  ])
    writeSource(directory, path);
  writeSource(directory, '.gitignore', 'packages/mobile/src/ignored.ts\n');
  git(directory, ['add', '.']);
  git(directory, ['commit', '--quiet', '-m', 'Reviewed release']);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryRepositories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('tutorial release source provenance', () => {
  it('accepts a clean reviewed tree and respects ignored local files', () => {
    const directory = sourceRepository();
    writeSource(directory, 'packages/mobile/src/ignored.ts');
    expect(tutorialModifiedSourcePaths(directory)).toEqual([]);
    expect(() => assertTutorialReleaseClean(tutorialModifiedSourcePaths(directory))).not.toThrow();
  });

  it('finds unstaged, staged and untracked app source changes without relying on git status parsing', () => {
    const directory = sourceRepository();
    writeSource(directory, 'packages/mobile/src/screen.ts', 'export const revision = 2;\n');
    writeSource(directory, 'packages/backend/src/auth.ts', 'export const revision = 2;\n');
    git(directory, ['add', 'packages/backend/src/auth.ts']);
    writeSource(directory, 'packages/shared/queue/src/new-rule.ts');
    const changed = tutorialModifiedSourcePaths(directory).sort();
    expect(changed).toEqual([
      'packages/backend/src/auth.ts',
      'packages/mobile/src/screen.ts',
      'packages/shared/queue/src/new-rule.ts',
    ]);
    expect(() => assertTutorialReleaseClean(changed)).toThrow('packages/backend/src/auth.ts');
  });

  it('permits tracked and untracked tutorial tooling while guarding app sources', () => {
    const directory = sourceRepository();
    writeSource(directory, 'scripts/instructional-video.ts', 'export const revision = 2;\n');
    writeSource(directory, 'packages/backend/src/scripts/seed-instructional-video.ts', 'export const revision = 2;\n');
    git(directory, ['add', 'packages/backend/src/scripts/seed-instructional-video.ts']);
    writeSource(directory, 'packages/backend/src/scripts/serve-instructional-video.ts');
    writeSource(directory, 'packages/web/scripts/render-instructional-video.ts');
    writeSource(directory, 'marketing/instructional-video/stage.mjs');
    expect(tutorialModifiedSourcePaths(directory)).toEqual([]);
  });

  it('compares against the pinned commit even when a newer HEAD is clean', () => {
    const directory = sourceRepository();
    const reviewedCommit = git(directory, ['rev-parse', 'HEAD']);
    writeSource(directory, 'packages/mobile/src/screen.ts', 'export const revision = 2;\n');
    git(directory, ['add', 'packages/mobile/src/screen.ts']);
    git(directory, ['commit', '--quiet', '-m', 'Unshipped screen change']);
    expect(tutorialModifiedSourcePaths(directory)).toEqual([]);
    expect(tutorialModifiedSourcePaths(directory, reviewedCommit)).toEqual(['packages/mobile/src/screen.ts']);
  });
});
