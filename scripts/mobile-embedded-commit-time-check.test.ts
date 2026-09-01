/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  findEmbeddedManifests,
  main,
  resolveExpectedCommitTime,
  verifyEmbeddedCommitTime,
} from './mobile-embedded-commit-time-check';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MOBILE_PACKAGE_JSON = resolve(REPO_ROOT, 'packages/mobile/package.json');

// Load the INSTALLED, PATCHED module the way the Xcode script phase and the Gradle
// task do — by absolute path inside the resolved expo-updates package. Requiring
// the real file (rather than modelling the patch in TS) means these tests go red
// if patches/expo-updates@57.0.19.patch ever stops applying.
type PatchedManifestModule = {
  // A property, not a method signature: it is a plain module export with no
  // `this`, and the method form trips typescript(unbound-method) on destructuring.
  resolveEmbeddedCommitTime: (projectRoot: string, now?: number) => number;
};
const requireFromMobile = createRequire(MOBILE_PACKAGE_JSON);
const expoUpdatesRoot = dirname(requireFromMobile.resolve('expo-updates/package.json'));
const MANIFEST_MODULE_PATH = resolve(expoUpdatesRoot, 'utils/build/createManifestForBuildAsync.js');
const { resolveEmbeddedCommitTime } = requireFromMobile(MANIFEST_MODULE_PATH) as PatchedManifestModule;

const temporaryRoots: string[] = [];

afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

function createTemporaryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'boardsesh-commit-time-'));
  temporaryRoots.push(dir);
  return dir;
}

// Record rather than NodeJS.ProcessEnv: that type requires NODE_ENV, so an env
// literal naming only the git variables is a TS2741 that only the full-repo,
// type-aware lint sees.
function git(cwd: string, args: string[], env: Record<string, string | undefined> = {}): void {
  execFileSync('git', args, { cwd, env: { ...process.env, ...env }, stdio: 'ignore' });
}

/** An initialised repo with no commits yet. */
function createEmptyRepo(): string {
  const dir = createTemporaryDir();
  git(dir, ['init', '--quiet']);
  return dir;
}

/** A repo whose single commit has the given committer (and, by default, author) date. */
function createRepoCommittedAt(committerDate: Date, authorDate: Date = committerDate): string {
  const dir = createEmptyRepo();
  git(dir, ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '--allow-empty', '-m', 'seed'], {
    GIT_COMMITTER_DATE: `@${Math.floor(committerDate.getTime() / 1000)} +0000`,
    GIT_AUTHOR_DATE: `@${Math.floor(authorDate.getTime() / 1000)} +0000`,
  });
  return dir;
}

describe('the patched expo-updates embedded commitTime', () => {
  it('embeds HEAD committer date, to the second', () => {
    const committedAt = new Date('2026-08-14T09:15:42.000Z');
    const projectRoot = createRepoCommittedAt(committedAt);

    expect(resolveEmbeddedCommitTime(projectRoot)).toBe(committedAt.getTime());
  });

  // %ct, not %at. A rebase or cherry-pick keeps the author date of the original
  // write, so ordering by it would put a backport ahead of work it contains.
  it('reads the committer date, not the author date', () => {
    const authoredAt = new Date('2026-01-02T03:04:05.000Z');
    const committedAt = new Date('2026-08-14T09:15:42.000Z');
    const projectRoot = createRepoCommittedAt(committedAt, authoredAt);

    expect(resolveEmbeddedCommitTime(projectRoot)).toBe(committedAt.getTime());
    expect(resolveEmbeddedCommitTime(projectRoot)).not.toBe(authoredAt.getTime());
  });

  // A commit dated in the future would outrank every OTA published after it,
  // which is the exact failure this patch exists to remove.
  it('clamps a future-dated commit to now', () => {
    const now = new Date('2026-08-14T09:15:42.000Z').getTime();
    const projectRoot = createRepoCommittedAt(new Date(now + 7 * 24 * 60 * 60 * 1000));

    expect(resolveEmbeddedCommitTime(projectRoot, now)).toBe(now);
  });

  it('falls back to now in a repo with no commits', () => {
    const now = new Date('2026-08-14T09:15:42.000Z').getTime();

    expect(resolveEmbeddedCommitTime(createEmptyRepo(), now)).toBe(now);
  });

  // GIT_CEILING_DIRECTORIES stops git walking up into whatever repo the temp dir
  // happens to sit under, so this asserts the no-checkout path on any machine.
  it('falls back to now outside a git checkout', () => {
    const now = new Date('2026-08-14T09:15:42.000Z').getTime();
    const outsideAnyRepo = createTemporaryDir();
    const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = outsideAnyRepo;
    try {
      expect(resolveEmbeddedCommitTime(outsideAnyRepo, now)).toBe(now);
    } finally {
      if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
    }
  });

  // The acceptance criterion from #5021: two binaries built OUT OF ORDER from
  // commits A (earlier) and B (later) must still embed times in commit order.
  it('orders two builds by commit date regardless of which one builds first', () => {
    const earlierCommit = createRepoCommittedAt(new Date('2026-08-14T09:00:00.000Z'));
    const laterCommit = createRepoCommittedAt(new Date('2026-08-14T10:00:00.000Z'));

    // Build the LATER commit first, then the earlier one — the 2026-09-01 shape.
    const laterBuiltFirst = resolveEmbeddedCommitTime(laterCommit);
    const earlierBuiltSecond = resolveEmbeddedCommitTime(earlierCommit);

    expect(earlierBuiltSecond).toBeLessThan(laterBuiltFirst);
  });

  it('no longer stamps the build time into the manifest', () => {
    const source = execFileSync('cat', [MANIFEST_MODULE_PATH], { encoding: 'utf-8' });

    expect(source).toContain('commitTime: resolveEmbeddedCommitTime(projectRoot),');
    expect(source).not.toContain('commitTime: new Date().getTime(),');
  });
});

function writeManifest(root: string, relativePath: string, commitTime: unknown): void {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify({ id: 'abc', commitTime, assets: [] }));
}

describe('the embedded commitTime postcondition', () => {
  const expected = new Date('2026-08-14T09:15:42.000Z').getTime();

  it('reads commitTime out of every app.manifest under the build output', () => {
    const buildOutput = createTemporaryDir();
    writeManifest(buildOutput, 'Release-iphoneos/Boardsesh.app/EXUpdates.bundle/app.manifest', expected);
    writeManifest(buildOutput, 'intermediates/assets/release/app.manifest', expected);
    writeFileSync(join(buildOutput, 'not-a-manifest.json'), '{}');

    const manifests = findEmbeddedManifests(buildOutput);

    expect(manifests).toHaveLength(2);
    expect(manifests.every((manifest) => manifest.commitTime === expected)).toBe(true);
    expect(verifyEmbeddedCommitTime(manifests, expected).ok).toBe(true);
  });

  it('fails a manifest stamped with anything other than the committer date', () => {
    const buildOutput = createTemporaryDir();
    writeManifest(buildOutput, 'a/app.manifest', expected);
    writeManifest(buildOutput, 'b/app.manifest', expected + 45 * 60 * 1000);

    const verdict = verifyEmbeddedCommitTime(findEmbeddedManifests(buildOutput), expected);

    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('b/app.manifest');
    expect(verdict.message).not.toContain('a/app.manifest');
  });

  it('fails an unreadable or non-numeric commitTime rather than skipping it', () => {
    const buildOutput = createTemporaryDir();
    writeManifest(buildOutput, 'a/app.manifest', 'not-a-number');
    mkdirSync(join(buildOutput, 'b'), { recursive: true });
    writeFileSync(join(buildOutput, 'b/app.manifest'), '{ this is not json');

    const verdict = verifyEmbeddedCommitTime(findEmbeddedManifests(buildOutput), expected);

    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('unreadable');
  });

  // "Nothing to check" is how this guard would go vacuous the day a build layout
  // moves, so an empty result is a failure.
  it('fails when it finds no manifest at all', () => {
    expect(findEmbeddedManifests(join(createTemporaryDir(), 'does-not-exist'))).toEqual([]);
    expect(verifyEmbeddedCommitTime([], expected).ok).toBe(false);
    expect(verifyEmbeddedCommitTime([], expected).message).toContain('No app.manifest found');
  });

  // The contract both native workflows call across. A `--search-root` typo, or a
  // build layout that moves, has to exit non-zero rather than find nothing and
  // shrug.
  describe('the command the native workflows run', () => {
    it('exits 0 only when the found manifests match HEAD', () => {
      const buildOutput = createTemporaryDir();
      writeManifest(buildOutput, 'Boardsesh.app/EXUpdates.bundle/app.manifest', resolveExpectedCommitTime());

      expect(main(['--search-root', buildOutput])).toBe(0);
    });

    it('exits 1 on a manifest stamped with build time instead', () => {
      const buildOutput = createTemporaryDir();
      writeManifest(buildOutput, 'Boardsesh.app/EXUpdates.bundle/app.manifest', Date.now());

      expect(main(['--search-root', buildOutput])).toBe(1);
    });

    it('exits 1 when given no search root, and when the root holds nothing', () => {
      expect(main([])).toBe(1);
      expect(main(['--search-root', createTemporaryDir()])).toBe(1);
    });

    it('searches every root it is given', () => {
      const first = createTemporaryDir();
      const second = createTemporaryDir();
      writeManifest(second, 'assets/app.manifest', resolveExpectedCommitTime());

      expect(main(['--search-root', first, '--search-root', second])).toBe(0);
    });
  });

  it('expects HEAD committer date in this checkout', () => {
    const headCommitterSeconds = Number(
      execFileSync('git', ['log', '-1', '--format=%ct', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf-8' }).trim(),
    );

    expect(resolveExpectedCommitTime()).toBe(headCommitterSeconds * 1000);
  });
});
