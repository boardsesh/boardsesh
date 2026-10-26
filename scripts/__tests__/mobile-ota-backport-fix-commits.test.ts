/// <reference types="node" />

// The backport publishes a production OTA from cherry-picked commits, so it must
// only take commits already reviewed onto main. Runs the real step in a scratch
// repository with an `origin` that also carries an unreviewed branch.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Step = { name?: string; run?: string };
const workflow = parse(
  readFileSync(resolve(import.meta.dirname, '../../.github/workflows/mobile-ota-backport.yml'), 'utf8'),
) as { jobs: Record<string, { steps: Step[] }> };
const anchorStep = workflow.jobs.backport.steps.find(
  (step) => step.name === 'Locate the release anchor and prepare the hotfix tree',
)?.run;

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

let root = '';
let runner = '';
let fixOnMain = '';
let unreviewed = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'backport-fix-commits-'));
  const origin = join(root, 'origin.git');
  const author = join(root, 'author');
  runner = join(root, 'runner');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, author);
  writeFileSync(join(author, 'app.ts'), 'base\n');
  git(author, 'add', '-A');
  git(author, 'commit', '-qm', 'base');
  git(author, 'tag', 'release/ios-v1.0.0-abcdef123456');
  writeFileSync(join(author, 'fix.ts'), 'reviewed fix\n');
  git(author, 'add', '-A');
  git(author, 'commit', '-qm', 'fix');
  fixOnMain = git(author, 'rev-parse', 'HEAD');
  git(author, 'push', '-q', 'origin', 'main', '--tags');
  git(author, 'checkout', '-qb', 'unreviewed', 'release/ios-v1.0.0-abcdef123456');
  writeFileSync(join(author, 'evil.ts'), 'unreviewed\n');
  git(author, 'add', '-A');
  git(author, 'commit', '-qm', 'unreviewed');
  unreviewed = git(author, 'rev-parse', 'HEAD');
  git(author, 'push', '-q', 'origin', 'unreviewed');
  // Like actions/checkout with fetch-depth 0: every branch and tag is local.
  git(root, 'clone', '-q', origin, runner);
  git(runner, 'fetch', '-q', '--tags', 'origin');
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function runStep(fixCommits: string) {
  git(runner, 'checkout', '-q', '--detach', 'origin/main');
  const output = join(root, `output-${Math.random().toString(36).slice(2)}`);
  writeFileSync(output, '');
  return spawnSync('bash', ['-c', anchorStep ?? 'exit 99'], {
    cwd: runner,
    encoding: 'utf8',
    env: {
      ...gitEnv,
      VERSION: '1.0.0',
      PLATFORM: 'ios',
      FIX_COMMITS: fixCommits,
      CONFIRM_ANDROID_SHIPPED: 'false',
      GITHUB_OUTPUT: output,
      GITHUB_RUN_ID: String(Date.now()),
    },
  });
}

describe('backport fix commits', () => {
  it('cherry-picks a commit that is on main', () => {
    const result = runStep(fixOnMain.slice(0, 12));
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(join(runner, 'fix.ts'), 'utf8')).toBe('reviewed fix\n');
  });

  it('refuses a commit that only exists on another branch', () => {
    const result = runStep(`${fixOnMain} ${unreviewed}`);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(`${unreviewed} is not on main`);
  });

  it('refuses an unknown SHA', () => {
    const result = runStep('deadbeefdeadbeef');
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('is not a single known commit');
  });
});
