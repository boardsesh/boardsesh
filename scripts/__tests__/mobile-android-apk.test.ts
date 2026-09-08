/// <reference types="node" />
import { describe, expect, it } from 'vitest';

// Only pure exports: importing the module must not (and does not) spawn gh/git.
import { DEV_APK_FRESHNESS_PATHS, devApkFreshness, formatApkOutputs, type GitRunner } from '../mobile-android-apk';

const HEAD = 'a'.repeat(40);
const TAG_COMMIT = 'b'.repeat(40);

// Spelled out rather than derived from the export, so dropping a path fails both
// this list AND the `git diff` invocation below — a self-referential assertion
// would happily agree with a shortened list.
const EXPECTED_FRESHNESS_PATHS = [
  'packages/mobile/app.config.ts',
  'packages/mobile/package.json',
  'package.json',
  'pnpm-workspace.yaml',
  'packages/mobile/plugins',
  'packages/mobile/modules',
  'packages/mobile/dev-assets',
  'patches',
  '.github/workflows/android-apk-dev-client.yml',
];

interface GitCall {
  args: string[];
}

/**
 * Fake git: answers by subcommand, records every call. `status` values mirror
 * git's own contract — `diff --quiet` exits 1 on differences, `cat-file -e` and
 * `merge-base --is-ancestor` exit non-zero on "no".
 */
function fakeGit(
  answers: {
    catFile?: number[];
    fetch?: number;
    isAncestor?: number;
    diff?: number;
  },
  calls: GitCall[] = [],
): GitRunner {
  const catFileAnswers = [...(answers.catFile ?? [0])];
  return (args: string[]) => {
    calls.push({ args });
    const status = (() => {
      if (args[0] === 'cat-file') return catFileAnswers.shift() ?? 1;
      if (args[0] === 'fetch') return answers.fetch ?? 0;
      if (args[0] === 'merge-base') return answers.isAncestor ?? 0;
      if (args[0] === 'diff') return answers.diff ?? 0;
      return 1;
    })();
    return { status, stdout: '' };
  };
}

describe('devApkFreshness', () => {
  it('is fresh when the release commit is an ancestor with no native-input diff', () => {
    expect(devApkFreshness(HEAD, TAG_COMMIT, fakeGit({ catFile: [0], isAncestor: 0, diff: 0 }))).toEqual({
      fresh: true,
    });
  });

  it('reports not-an-ancestor when the release commit is not in this history', () => {
    const calls: GitCall[] = [];
    expect(devApkFreshness(HEAD, TAG_COMMIT, fakeGit({ catFile: [0], isAncestor: 1 }, calls))).toEqual({
      fresh: false,
      reason: 'not-an-ancestor',
    });

    // Pins the argument ORDER: `merge-base --is-ancestor <tagCommit> <headSha>`
    // asks "is the release commit an ancestor of HEAD?" — swapped, it silently
    // asks the opposite question and this test would stay green.
    const mergeBaseCall = calls.find((call) => call.args[0] === 'merge-base');
    expect(mergeBaseCall?.args).toEqual(['merge-base', '--is-ancestor', TAG_COMMIT, HEAD]);
  });

  it('reports native-inputs-changed when git diff exits 1', () => {
    expect(devApkFreshness(HEAD, TAG_COMMIT, fakeGit({ catFile: [0], isAncestor: 0, diff: 1 }))).toEqual({
      fresh: false,
      reason: 'native-inputs-changed',
    });
  });

  it('reports unknown when git diff fails outright (not a 0/1 answer)', () => {
    expect(devApkFreshness(HEAD, TAG_COMMIT, fakeGit({ catFile: [0], isAncestor: 0, diff: 128 }))).toEqual({
      fresh: false,
      reason: 'unknown',
    });
  });

  it('fetches a missing release commit once, then answers on the re-check', () => {
    const calls: GitCall[] = [];
    // Missing, then present after the fetch.
    const verdict = devApkFreshness(HEAD, TAG_COMMIT, fakeGit({ catFile: [1, 0], isAncestor: 0, diff: 0 }, calls));

    expect(verdict).toEqual({ fresh: true });
    expect(calls.map((call) => call.args[0])).toEqual(['cat-file', 'fetch', 'cat-file', 'merge-base', 'diff']);
    expect(calls[1].args).toEqual(['fetch', '--quiet', 'origin', TAG_COMMIT]);
  });

  it('is unknown when the release commit is still missing after the fetch', () => {
    const calls: GitCall[] = [];
    const verdict = devApkFreshness(HEAD, TAG_COMMIT, fakeGit({ catFile: [1, 1], fetch: 128 }, calls));

    expect(verdict).toEqual({ fresh: false, reason: 'unknown' });
    // No ancestry/diff question is asked against a commit we don't have.
    expect(calls.map((call) => call.args[0])).toEqual(['cat-file', 'fetch', 'cat-file']);
  });

  // A native deploy publishes a fresh rn-android-dev-* release on every push to
  // main, so a workflow pinned to an older commit (e.g. a `workflow_run.head_sha`
  // from 30-50 minutes earlier) often finds the newest release is a DESCENDANT
  // of HEAD rather than an ancestor. These three cover that reversed direction.
  // Distinct from `fakeGit`: the two merge-base calls ask opposite questions and
  // must get opposite answers, which `fakeGit`'s single `isAncestor` knob can't
  // express.
  function directionalGit(
    answers: { tagAncestorOfHead: number; headAncestorOfTag: number; diff?: number },
    calls: GitCall[] = [],
  ): GitRunner {
    return (args: string[]) => {
      calls.push({ args });
      if (args[0] === 'cat-file') return { status: 0, stdout: '' };
      if (args[0] === 'merge-base') {
        const isTagFirst = args[2] === TAG_COMMIT && args[3] === HEAD;
        return { status: isTagFirst ? answers.tagAncestorOfHead : answers.headAncestorOfTag, stdout: '' };
      }
      if (args[0] === 'diff') return { status: answers.diff ?? 0, stdout: '' };
      return { status: 1, stdout: '' };
    };
  }

  it('is fresh with newer-release-same-native-inputs when HEAD is an ancestor of a newer release with no native diff', () => {
    const calls: GitCall[] = [];
    const verdict = devApkFreshness(
      HEAD,
      TAG_COMMIT,
      directionalGit({ tagAncestorOfHead: 1, headAncestorOfTag: 0, diff: 0 }, calls),
    );

    expect(verdict).toEqual({ fresh: true, reason: 'newer-release-same-native-inputs' });

    const mergeBaseCalls = calls.filter((call) => call.args[0] === 'merge-base');
    expect(mergeBaseCalls.map((call) => call.args)).toEqual([
      ['merge-base', '--is-ancestor', TAG_COMMIT, HEAD],
      ['merge-base', '--is-ancestor', HEAD, TAG_COMMIT],
    ]);
    const diffCall = calls.find((call) => call.args[0] === 'diff');
    expect(diffCall?.args.slice(0, 4)).toEqual(['diff', '--quiet', HEAD, TAG_COMMIT]);
  });

  it('is stale (native-inputs-changed) when HEAD is an ancestor of a newer release but native inputs differ', () => {
    const verdict = devApkFreshness(
      HEAD,
      TAG_COMMIT,
      directionalGit({ tagAncestorOfHead: 1, headAncestorOfTag: 0, diff: 1 }),
    );

    expect(verdict).toEqual({ fresh: false, reason: 'native-inputs-changed' });
  });

  it('is stale (not-an-ancestor) when the release and HEAD have diverged', () => {
    const verdict = devApkFreshness(HEAD, TAG_COMMIT, directionalGit({ tagAncestorOfHead: 1, headAncestorOfTag: 1 }));

    expect(verdict).toEqual({ fresh: false, reason: 'not-an-ancestor' });
  });

  it('diffs every freshness path (a dropped path would silently pass a stale APK)', () => {
    const calls: GitCall[] = [];
    devApkFreshness(HEAD, TAG_COMMIT, fakeGit({ catFile: [0], isAncestor: 0, diff: 0 }, calls));

    const diffCall = calls.find((call) => call.args[0] === 'diff');
    expect(diffCall).toBeDefined();
    const pathArgs = diffCall!.args.slice(diffCall!.args.indexOf('--') + 1);
    expect(pathArgs).toEqual(EXPECTED_FRESHNESS_PATHS);
    expect(diffCall!.args.slice(0, 4)).toEqual(['diff', '--quiet', TAG_COMMIT, HEAD]);
  });
});

describe('DEV_APK_FRESHNESS_PATHS', () => {
  it('covers the native inputs plus the producer workflow, and skips the lockfile', () => {
    expect([...DEV_APK_FRESHNESS_PATHS]).toEqual(EXPECTED_FRESHNESS_PATHS);
  });
});

describe('formatApkOutputs', () => {
  it('writes the two GITHUB_OUTPUT lines, newline-terminated', () => {
    expect(formatApkOutputs({ apkPath: '/cache/boardsesh-dev-android.apk', source: 'release:rn-android-dev-42' })).toBe(
      'apk_path=/cache/boardsesh-dev-android.apk\napk_source=release:rn-android-dev-42\n',
    );
    expect(formatApkOutputs({ apkPath: '/cache/app-debug.apk', source: 'local-build' })).toBe(
      'apk_path=/cache/app-debug.apk\napk_source=local-build\n',
    );
  });
});
