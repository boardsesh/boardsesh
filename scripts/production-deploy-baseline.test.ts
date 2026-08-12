import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  classifyProductionTarget,
  GENERATED_CHANGELOG_COMMIT_SUBJECT,
  selectChangelogSnapshotSha,
  selectProductionDeployBaseline,
  ZERO_SHA,
} from './production-deploy-baseline.mjs';

const DEPLOY_SHA = 'deploy';
const PREVIOUS_SHA = 'previous';
const BASELINE_SCRIPT = fileURLToPath(new URL('./production-deploy-baseline.mjs', import.meta.url));
const GENERATED_CHANGELOG_COMMIT = {
  sha: 'generated-changelog-commit',
  subject: GENERATED_CHANGELOG_COMMIT_SUBJECT,
  authorEmail: 'github-actions[bot]@users.noreply.github.com',
  parentCount: 1,
  changedFiles: ['CHANGELOG.md', 'packages/mobile/src/data/changelog.generated.json'],
};

function selectBaseline(overrides: Record<string, unknown> = {}) {
  return selectProductionDeployBaseline({
    deploySha: DEPLOY_SHA,
    changelogBaseSha: PREVIOUS_SHA,
    previousRunsResponse: {
      workflow_runs: [
        {
          id: 42,
          head_sha: PREVIOUS_SHA,
          conclusion: 'success',
          updated_at: '2026-08-01T12:00:00Z',
        },
      ],
    },
    previousJobsResponse: {
      jobs: [
        { name: 'notify-no-promote', conclusion: 'skipped' },
        { name: 'mark-production-promoted', conclusion: 'success' },
      ],
    },
    isAncestor: () => true,
    commitsBetween: () => [],
    ...overrides,
  });
}

describe('production deploy baseline selection', () => {
  it('uses the last proven promoted commit instead of the event boundary', () => {
    expect(selectBaseline()).toEqual({
      forceComponents: false,
      componentBaseSha: PREVIOUS_SHA,
      reason: 'immediate predecessor is proven promoted',
    });
  });

  it.each(['failure', 'cancelled'])('forces a full release after a %s predecessor', (conclusion) => {
    expect(
      selectBaseline({
        previousRunsResponse: {
          workflow_runs: [
            {
              id: 42,
              head_sha: PREVIOUS_SHA,
              conclusion,
              updated_at: '2026-08-01T12:00:00Z',
            },
          ],
        },
      }).forceComponents,
    ).toBe(true);
  });

  it('forces a full release after a rollback-held predecessor', () => {
    expect(
      selectBaseline({
        previousJobsResponse: { jobs: [{ name: 'notify-no-promote', conclusion: 'success' }] },
      }).forceComponents,
    ).toBe(true);
  });

  it('forces a full release after a held/noop run or failed promotion marker', () => {
    expect(selectBaseline({ previousJobsResponse: { jobs: [] } }).forceComponents).toBe(true);
    expect(
      selectBaseline({
        previousJobsResponse: {
          jobs: [{ name: 'mark-production-promoted', conclusion: 'failure' }],
        },
      }).forceComponents,
    ).toBe(true);
  });

  it('forces a full release when history, jobs, or a prior run is unavailable', () => {
    expect(selectBaseline({ previousRunsResponse: null }).forceComponents).toBe(true);
    expect(selectBaseline({ previousRunsResponse: { workflow_runs: [] } }).forceComponents).toBe(true);
    expect(selectBaseline({ previousJobsResponse: null }).forceComponents).toBe(true);
  });

  it('selects by completion proxy when creation and run-start ordering disagree', () => {
    expect(
      selectBaseline({
        changelogBaseSha: 'older-created-manual',
        previousRunsResponse: {
          workflow_runs: [
            {
              id: 52,
              head_sha: 'newer-created',
              conclusion: 'success',
              created_at: '2026-08-01T11:05:00Z',
              run_started_at: '2026-08-01T11:25:00Z',
              updated_at: '2026-08-01T11:20:00Z',
            },
            {
              id: 51,
              head_sha: 'older-created-manual',
              conclusion: 'success',
              created_at: '2026-08-01T11:00:00Z',
              run_started_at: '2026-08-01T11:10:00Z',
              updated_at: '2026-08-01T11:30:00Z',
            },
          ],
        },
      }),
    ).toEqual({
      forceComponents: false,
      componentBaseSha: 'older-created-manual',
      reason: 'immediate predecessor is proven promoted',
    });
  });

  it('fails closed when completion ordering is missing or ambiguous', () => {
    expect(
      selectBaseline({
        previousRunsResponse: {
          workflow_runs: [{ id: 42, head_sha: PREVIOUS_SHA, conclusion: 'success' }],
        },
      }).forceComponents,
    ).toBe(true);
    expect(
      selectBaseline({
        previousRunsResponse: {
          workflow_runs: [
            {
              id: 42,
              head_sha: PREVIOUS_SHA,
              conclusion: 'success',
              updated_at: '2026-08-01T12:00:00Z',
            },
            {
              id: 43,
              head_sha: 'other',
              conclusion: 'success',
              updated_at: '2026-08-01T12:00:00Z',
            },
          ],
        },
      }).forceComponents,
    ).toBe(true);
  });

  it('forces a full release for a missing or non-ancestor baseline', () => {
    expect(selectBaseline({ changelogBaseSha: ZERO_SHA }).forceComponents).toBe(true);
    expect(selectBaseline({ isAncestor: () => false }).forceComponents).toBe(true);
  });

  it('accepts a workflow-generated changelog commit without using it as the component baseline', () => {
    expect(
      selectBaseline({
        changelogBaseSha: 'generated-changelog-commit',
        commitsBetween: () => [GENERATED_CHANGELOG_COMMIT],
      }),
    ).toEqual({
      forceComponents: false,
      componentBaseSha: PREVIOUS_SHA,
      reason: 'previous production commit is followed only by workflow-owned changelog files',
    });
  });

  it('forces a full release when an unpromoted source change follows the prior deployment', () => {
    expect(
      selectBaseline({
        changelogBaseSha: 'unpromoted-commit',
        commitsBetween: () => [
          {
            ...GENERATED_CHANGELOG_COMMIT,
            sha: 'source-change',
            subject: 'fix: backend race',
            authorEmail: 'developer@example.com',
            changedFiles: ['packages/backend/src/index.ts'],
          },
        ],
      }).forceComponents,
    ).toBe(true);
  });

  it('does not trust a human-authored changelog-only commit', () => {
    expect(
      selectBaseline({
        changelogBaseSha: 'human-changelog-commit',
        commitsBetween: () => [
          {
            ...GENERATED_CHANGELOG_COMMIT,
            sha: 'human-changelog-commit',
            subject: 'docs: edit changelog',
            authorEmail: 'developer@example.com',
          },
        ],
      }).forceComponents,
    ).toBe(true);
  });

  it('does not trust a merge commit even when its message and paths look generated', () => {
    expect(
      selectBaseline({
        changelogBaseSha: 'merge-changelog-commit',
        commitsBetween: () => [{ ...GENERATED_CHANGELOG_COMMIT, parentCount: 2 }],
      }).forceComponents,
    ).toBe(true);
  });

  it('does not trust an exact generated subject when an extra path or author is wrong', () => {
    expect(
      selectBaseline({
        changelogBaseSha: 'extra-path',
        commitsBetween: () => [
          {
            ...GENERATED_CHANGELOG_COMMIT,
            changedFiles: [...GENERATED_CHANGELOG_COMMIT.changedFiles, 'packages/backend/src/index.ts'],
          },
        ],
      }).forceComponents,
    ).toBe(true);
    expect(
      selectBaseline({
        changelogBaseSha: 'spoofed-author',
        commitsBetween: () => [{ ...GENERATED_CHANGELOG_COMMIT, authorEmail: 'developer@example.com' }],
      }).forceComponents,
    ).toBe(true);
  });
});

describe('stale production target classification', () => {
  it('skips an older queued target when newer source code is already on main', () => {
    expect(
      classifyProductionTarget({
        deploySha: 'push-b',
        currentMainSha: 'push-c',
        isAncestor: () => true,
        commitsBetween: () => [
          {
            ...GENERATED_CHANGELOG_COMMIT,
            sha: 'push-c',
            subject: 'fix: newer source',
            changedFiles: ['packages/backend/src/index.ts'],
          },
        ],
      }),
    ).toEqual({
      superseded: true,
      changelogSnapshotSha: null,
      reason: 'newer source changes exist on main',
    });
  });

  it('allows a target followed only by the workflow-generated changelog commit', () => {
    expect(
      classifyProductionTarget({
        deploySha: 'push-b',
        currentMainSha: 'changelog-commit',
        isAncestor: () => true,
        commitsBetween: () => [{ ...GENERATED_CHANGELOG_COMMIT, sha: 'changelog-commit' }],
      }),
    ).toEqual({
      superseded: false,
      changelogSnapshotSha: 'changelog-commit',
      reason: 'only positively identified workflow changelog commits are ahead of target',
    });
  });

  it('does not exempt human-authored changelog-only work from the stale-run guard', () => {
    expect(
      classifyProductionTarget({
        deploySha: 'push-b',
        currentMainSha: 'human-changelog',
        isAncestor: () => true,
        commitsBetween: () => [
          {
            ...GENERATED_CHANGELOG_COMMIT,
            sha: 'human-changelog',
            subject: 'docs: update changelog',
          },
        ],
      }).superseded,
    ).toBe(true);
  });

  it('skips a target on a replaced or unclassifiable history', () => {
    expect(
      classifyProductionTarget({
        deploySha: 'old-history',
        currentMainSha: 'new-history',
        isAncestor: () => false,
        commitsBetween: () => [],
      }).superseded,
    ).toBe(true);
    expect(
      classifyProductionTarget({
        deploySha: 'push-b',
        currentMainSha: 'push-c',
        isAncestor: () => true,
        commitsBetween: () => {
          throw new Error('git unavailable');
        },
      }).superseded,
    ).toBe(true);
  });
});

describe('queued changelog snapshot selection', () => {
  it('uses A run’s generated C snapshot for queued target B without changing B’s range base', () => {
    const releaseRangeBase = 'push-a';
    const selectedSnapshot = selectChangelogSnapshotSha({
      deploySha: 'push-b',
      currentMainSha: 'generated-c',
      isAncestor: (ancestor: string, descendant: string) => ancestor === 'push-b' && descendant === 'generated-c',
      commitsBetween: () => [{ ...GENERATED_CHANGELOG_COMMIT, sha: 'generated-c' }],
    });

    expect(releaseRangeBase).toBe('push-a');
    expect(selectedSnapshot).toBe('generated-c');
  });

  it('proves the A/B/C queued topology against real per-commit git evidence', () => {
    const repositoryDirectory = mkdtempSync(resolve(tmpdir(), 'boardsesh-baseline-'));
    const runGit = (...arguments_: string[]): string => {
      const result = spawnSync('git', arguments_, {
        cwd: repositoryDirectory,
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };

    try {
      runGit('init', '--quiet');
      runGit('config', 'user.name', 'Developer');
      runGit('config', 'user.email', 'developer@example.com');
      writeFileSync(resolve(repositoryDirectory, 'source.txt'), 'push A\n');
      runGit('add', 'source.txt');
      runGit('commit', '--quiet', '-m', 'fix: push A');
      const pushASha = runGit('rev-parse', 'HEAD');

      writeFileSync(resolve(repositoryDirectory, 'source.txt'), 'push B\n');
      runGit('add', 'source.txt');
      runGit('commit', '--quiet', '-m', 'fix: push B');
      const queuedPushBSha = runGit('rev-parse', 'HEAD');

      runGit('config', 'user.name', 'github-actions[bot]');
      runGit('config', 'user.email', 'github-actions[bot]@users.noreply.github.com');
      mkdirSync(resolve(repositoryDirectory, 'packages/mobile/src/data'), { recursive: true });
      writeFileSync(resolve(repositoryDirectory, 'CHANGELOG.md'), 'A release notes\n');
      writeFileSync(
        resolve(repositoryDirectory, 'packages/mobile/src/data/changelog.generated.json'),
        '{"entries":[{"title":"A"}]}\n',
      );
      runGit('add', 'CHANGELOG.md', 'packages/mobile/src/data/changelog.generated.json');
      runGit('commit', '--quiet', '-m', GENERATED_CHANGELOG_COMMIT_SUBJECT);
      const generatedCSha = runGit('rev-parse', 'HEAD');

      const snapshotResult = spawnSync(process.execPath, [BASELINE_SCRIPT, 'changelog-snapshot'], {
        cwd: repositoryDirectory,
        encoding: 'utf8',
        env: {
          ...process.env,
          DEPLOY_SHA: queuedPushBSha,
          CURRENT_MAIN_SHA: generatedCSha,
        },
      });

      expect(snapshotResult.status, snapshotResult.stderr).toBe(0);
      expect(snapshotResult.stdout.trim()).toBe(generatedCSha);
      expect(pushASha).not.toBe(generatedCSha);
    } finally {
      rmSync(repositoryDirectory, { recursive: true, force: true });
    }
  });

  it('selects the newest commit only when every commit ahead is positively generated', () => {
    expect(
      selectChangelogSnapshotSha({
        deploySha: 'push-b',
        currentMainSha: 'generated-d',
        isAncestor: () => true,
        commitsBetween: () => [
          { ...GENERATED_CHANGELOG_COMMIT, sha: 'generated-c' },
          { ...GENERATED_CHANGELOG_COMMIT, sha: 'generated-d' },
        ],
      }),
    ).toBe('generated-d');

    expect(
      selectChangelogSnapshotSha({
        deploySha: 'push-b',
        currentMainSha: 'generated-after-source',
        isAncestor: () => true,
        commitsBetween: () => [
          {
            ...GENERATED_CHANGELOG_COMMIT,
            sha: 'source-change',
            subject: 'fix: newer source',
            changedFiles: ['packages/web/app/page.tsx'],
          },
          { ...GENERATED_CHANGELOG_COMMIT, sha: 'generated-after-source' },
        ],
      }),
    ).toBeNull();
  });
});
