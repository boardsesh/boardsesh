/// <reference types="node" />

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compareDevNativeInputs,
  devFingerprintEnvironment,
  latestPublishedDevApk,
  type NativeCommandRunner,
} from '../lib/android-dev-native';
import type { RunOptions, RunResult } from '../lib/exec';
import { decideDevBuild } from '../mobile-android-dev-gate';

const HEAD_COMMIT = 'a'.repeat(40);
const BASE_COMMIT = 'b'.repeat(40);
const SHARED_FINGERPRINT = 'c'.repeat(40);
const CHANGED_FINGERPRINT = 'd'.repeat(40);
const RELEASES_ENDPOINT = 'repos/{owner}/{repo}/releases?per_page=100';
const RUNS_ENDPOINT = `repos/{owner}/{repo}/actions/workflows/android-apk-dev-client.yml/runs?head_sha=${BASE_COMMIT}&per_page=100`;
const temporaryRoots: string[] = [];

function result(stdout = '', status = 0, stderr = ''): RunResult {
  return { stdout, status, stderr };
}

function releaseFixture(buildNumber = 24, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: `rn-android-dev-${buildNumber}`,
    draft: false,
    prerelease: true,
    html_url: `https://github.com/boardsesh/boardsesh/releases/tag/rn-android-dev-${buildNumber}`,
    assets: [{ name: 'boardsesh-dev-android.apk', state: 'uploaded', size: 1234 }],
    ...overrides,
  };
}

function runFixture(buildNumber = 24, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1234,
    run_number: buildNumber,
    status: 'completed',
    conclusion: 'success',
    head_sha: BASE_COMMIT,
    head_branch: 'main',
    path: '.github/workflows/android-apk-dev-client.yml',
    ...overrides,
  };
}

interface CommandCall {
  command: string;
  args: string[];
  options?: RunOptions;
}

function apiRunner(
  responses: Map<string, unknown>,
  calls: CommandCall[] = [],
  fallback?: NativeCommandRunner,
): NativeCommandRunner {
  return (command, args, options) => {
    calls.push({ command, args: [...args], options });
    if (command === 'gh' && args[0] === 'api') {
      const response = responses.get(args[1]!);
      if (response === undefined) throw new Error(`Unexpected API request: ${args[1]}`);
      return result(JSON.stringify(response));
    }
    if (fallback) return fallback(command, args, options);
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };
}

function successfulBaselineResponses(): Map<string, unknown> {
  return new Map<string, unknown>([
    [RELEASES_ENDPOINT, [[releaseFixture()]]],
    ['repos/{owner}/{repo}/git/ref/tags/rn-android-dev-24', { object: { type: 'commit', sha: BASE_COMMIT } }],
    [RUNS_ENDPOINT, [{ workflow_runs: [runFixture()] }]],
  ]);
}

function nativeRunner(options: { diffStatus?: number; fingerprints?: string[]; resolverFailureAt?: number } = {}) {
  const calls: CommandCall[] = [];
  const worktrees: string[] = [];
  const resolvedTrees: Array<{ cwd: string; env: NodeJS.ProcessEnv; envContents: string }> = [];
  const runner: NativeCommandRunner = (command, args, runOptions) => {
    calls.push({ command, args: [...args], options: runOptions });
    if (command === 'git') {
      if (args[0] === 'rev-parse') return result(HEAD_COMMIT);
      if (args[0] === 'cat-file') return result();
      if (args[0] === 'diff') return result('', options.diffStatus ?? 1, 'diff unavailable');
      if (args[0] === 'worktree' && args[1] === 'add') {
        const worktreePath = args[3]!;
        mkdirSync(join(worktreePath, 'packages/mobile'), { recursive: true });
        worktrees.push(worktreePath);
        return result();
      }
      if (args[0] === 'worktree' && args[1] === 'remove') return result();
    }
    if (command === 'vp' && args[0] === 'install') return result();
    if (command === 'vp' && args[0] === 'exec') {
      const cwd = runOptions?.cwd;
      if (!cwd || !runOptions?.env) throw new Error('Resolver needs its isolated tree and environment');
      resolvedTrees.push({
        cwd,
        env: { ...runOptions.env },
        envContents: readFileSync(join(cwd, '.env'), 'utf8'),
      });
      if (resolvedTrees.length === options.resolverFailureAt) return result('', 1, 'resolver failed');
      return result(
        `Expo diagnostic\n${JSON.stringify({
          runtimeVersion: options.fingerprints?.[resolvedTrees.length - 1] ?? SHARED_FINGERPRINT,
          fingerprintSources: [],
        })}\n`,
      );
    }
    throw new Error(`Unexpected native command: ${command} ${args.join(' ')}`);
  };
  return { runner, calls, worktrees, resolvedTrees };
}

afterEach(() => {
  for (const temporaryRoot of temporaryRoots.splice(0)) rmSync(temporaryRoot, { recursive: true, force: true });
});

describe('published Android dev-client baseline', () => {
  it('finds the highest build across release and successful workflow-run pages', () => {
    const responses = successfulBaselineResponses();
    responses.set(RELEASES_ENDPOINT, [[releaseFixture(9)], [releaseFixture(24)]]);
    responses.set(RUNS_ENDPOINT, [
      { workflow_runs: [runFixture(24, { conclusion: 'cancelled' })] },
      { workflow_runs: [runFixture()] },
    ]);
    const calls: CommandCall[] = [];

    expect(latestPublishedDevApk('/repo', apiRunner(responses, calls))).toEqual({
      tag: 'rn-android-dev-24',
      commit: BASE_COMMIT,
      url: 'https://github.com/boardsesh/boardsesh/releases/tag/rn-android-dev-24',
      runId: 1234,
    });
    for (const endpoint of [RELEASES_ENDPOINT, RUNS_ENDPOINT]) {
      expect(calls.find((call) => call.args[1] === endpoint)?.args).toEqual(['api', endpoint, '--paginate', '--slurp']);
    }
  });

  it('ignores drafts, full releases, missing assets and incomplete uploads', () => {
    const responses = successfulBaselineResponses();
    responses.set(RELEASES_ENDPOINT, [
      [
        releaseFixture(99, { draft: true }),
        releaseFixture(98, { prerelease: false }),
        releaseFixture(97, { assets: [] }),
        releaseFixture(96, { assets: [{ name: 'other.apk', state: 'uploaded', size: 1234 }] }),
        releaseFixture(95, { assets: [{ name: 'boardsesh-dev-android.apk', state: 'new', size: 1234 }] }),
        releaseFixture(94, { assets: [{ name: 'boardsesh-dev-android.apk', state: 'uploaded', size: 0 }] }),
        releaseFixture(93, { tag_name: 'build-android-v2.6.0-93' }),
        releaseFixture(),
      ],
    ]);

    expect(latestPublishedDevApk('/repo', apiRunner(responses))?.tag).toBe('rn-android-dev-24');
  });

  it.each([
    { conclusion: 'failure' },
    { conclusion: 'cancelled' },
    { status: 'in_progress' },
    { head_branch: 'feature/native' },
    { head_sha: HEAD_COMMIT },
    { run_number: 25 },
    { path: '.github/workflows/android-apk-rn.yml' },
  ])('rejects a release whose workflow provenance does not match: %j', (overrides) => {
    const responses = successfulBaselineResponses();
    responses.set(RUNS_ENDPOINT, [{ workflow_runs: [runFixture(24, overrides)] }]);
    expect(latestPublishedDevApk('/repo', apiRunner(responses))).toBeNull();
  });

  it('falls back from a cancelled newer build to the last successful APK', () => {
    const responses = successfulBaselineResponses();
    responses.set(RELEASES_ENDPOINT, [[releaseFixture(25), releaseFixture()]]);
    responses.set('repos/{owner}/{repo}/git/ref/tags/rn-android-dev-25', {
      object: { type: 'commit', sha: HEAD_COMMIT },
    });
    responses.set(
      `repos/{owner}/{repo}/actions/workflows/android-apk-dev-client.yml/runs?head_sha=${HEAD_COMMIT}&per_page=100`,
      [{ workflow_runs: [runFixture(25, { head_sha: HEAD_COMMIT, conclusion: 'cancelled' })] }],
    );
    expect(latestPublishedDevApk('/repo', apiRunner(responses))?.tag).toBe('rn-android-dev-24');
  });

  it('peels an annotated dev-client tag to its exact build commit', () => {
    const responses = successfulBaselineResponses();
    responses.set('repos/{owner}/{repo}/git/ref/tags/rn-android-dev-24', {
      object: { type: 'tag', sha: CHANGED_FINGERPRINT },
    });
    responses.set(`repos/{owner}/{repo}/git/tags/${CHANGED_FINGERPRINT}`, {
      object: { type: 'commit', sha: BASE_COMMIT },
    });
    expect(latestPublishedDevApk('/repo', apiRunner(responses))?.commit).toBe(BASE_COMMIT);
  });

  it('bootstraps only when no successfully published APK exists', () => {
    const calls: CommandCall[] = [];
    const runner = apiRunner(new Map([[RELEASES_ENDPOINT, [[]]]]), calls);
    expect(decideDevBuild('/repo', runner)).toEqual({
      shouldBuild: true,
      reason: 'No successfully published dev-client APK exists',
    });
    expect(calls).toHaveLength(1);
  });

  it('fails closed on GitHub transport or malformed pagination errors', () => {
    expect(() => decideDevBuild('/repo', () => result('', 1, 'GitHub unavailable'))).toThrow('GitHub unavailable');
    expect(() => decideDevBuild('/repo', apiRunner(new Map([[RELEASES_ENDPOINT, {}]])))).toThrow(
      'Invalid paginated GitHub API response',
    );
  });
});

describe('Android dev native compatibility', () => {
  it('avoids installations when every screened native path is unchanged', () => {
    const fixture = nativeRunner({ diffStatus: 0 });
    expect(compareDevNativeInputs('/repo', HEAD_COMMIT, BASE_COMMIT, {}, fixture.runner)).toEqual({
      compatible: true,
    });
    expect(fixture.calls.every((call) => call.command === 'git')).toBe(true);
    expect(fixture.worktrees).toEqual([]);
    const diff = fixture.calls.find((call) => call.args[0] === 'diff');
    expect(diff?.args.slice(0, 5)).toEqual(['diff', '--quiet', BASE_COMMIT, HEAD_COMMIT, '--']);
    expect(diff?.args).toEqual(
      expect.arrayContaining([
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'packages/mobile/fingerprint.config.js',
        'packages/mobile/dev-assets',
        'packages/mobile/modules',
        'packages/mobile/locales',
        'patches',
      ]),
    );
  });

  it('resolves both commits with identical dev environments without changing the caller tree', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'boardsesh-dev-native-test-'));
    temporaryRoots.push(repoRoot);
    mkdirSync(join(repoRoot, 'packages/mobile'), { recursive: true });
    const callerEnvPath = join(repoRoot, 'packages/mobile/.env');
    writeFileSync(callerEnvPath, 'MY_METRO_CONFIGURATION=keep\n');
    const environment = { EXPO_PUBLIC_POSTHOG_KEY: 'test-key', BOARDSESH_WEB: '1', EAS_BUILD_PROFILE: 'production' };
    const fixture = nativeRunner();

    expect(compareDevNativeInputs(repoRoot, HEAD_COMMIT, BASE_COMMIT, environment, fixture.runner)).toEqual({
      compatible: true,
      headFingerprint: SHARED_FINGERPRINT,
      baseFingerprint: SHARED_FINGERPRINT,
    });
    expect(fixture.resolvedTrees).toHaveLength(2);
    expect(fixture.resolvedTrees[0]?.env).toEqual(fixture.resolvedTrees[1]?.env);
    expect(fixture.resolvedTrees[0]?.envContents).toBe(fixture.resolvedTrees[1]?.envContents);
    expect(fixture.resolvedTrees[0]?.env).toMatchObject({ BOARDSESH_APP_VARIANT: 'dev', TAILSCALE_HOSTS: '', CI: '1' });
    expect(fixture.resolvedTrees[0]?.env).not.toHaveProperty('BOARDSESH_WEB');
    expect(fixture.resolvedTrees[0]?.env).not.toHaveProperty('EAS_BUILD_PROFILE');
    expect(fixture.resolvedTrees[0]?.envContents).toContain('EXPO_PUBLIC_POSTHOG_KEY=test-key\n');
    expect(fixture.resolvedTrees.every((tree) => tree.cwd !== join(repoRoot, 'packages/mobile'))).toBe(true);
    expect(readFileSync(callerEnvPath, 'utf8')).toBe('MY_METRO_CONFIGURATION=keep\n');
    expect(fixture.calls.filter((call) => call.command === 'vp' && call.args[0] === 'install')).toHaveLength(2);
    expect(
      fixture.calls.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'add').map((call) => call.args[4]),
    ).toEqual([HEAD_COMMIT, BASE_COMMIT]);
    expect(fixture.worktrees.every((worktreePath) => !existsSync(worktreePath))).toBe(true);
  });

  it.each([
    [SHARED_FINGERPRINT, false],
    [CHANGED_FINGERPRINT, true],
  ])(
    'skips version/unrelated dependency edits with equal fingerprints and builds changed native fingerprints: %s',
    (baseFingerprint, shouldBuild) => {
      const fixture = nativeRunner({ fingerprints: [SHARED_FINGERPRINT, baseFingerprint] });
      const decision = decideDevBuild('/repo', apiRunner(successfulBaselineResponses(), [], fixture.runner));
      expect(decision.shouldBuild).toBe(shouldBuild);
      expect(decision.releaseUrl).toBe('https://github.com/boardsesh/boardsesh/releases/tag/rn-android-dev-24');
      expect(fixture.resolvedTrees).toHaveLength(2);
    },
  );

  it('removes both isolated worktrees after a resolver failure', () => {
    const fixture = nativeRunner({ resolverFailureAt: 2 });
    expect(() => compareDevNativeInputs('/repo', HEAD_COMMIT, BASE_COMMIT, {}, fixture.runner)).toThrow(
      'resolver failed',
    );
    expect(fixture.worktrees).toHaveLength(2);
    const removals = fixture.calls.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'remove');
    expect(removals.map((call) => call.args[3])).toEqual([...fixture.worktrees].reverse());
    expect(fixture.worktrees.every((worktreePath) => !existsSync(worktreePath))).toBe(true);
    expect(existsSync(dirname(fixture.worktrees[0]!))).toBe(false);
  });

  it('fails closed rather than bootstrapping when the native diff fails', () => {
    const fixture = nativeRunner({ diffStatus: 128 });
    expect(() => decideDevBuild('/repo', apiRunner(successfulBaselineResponses(), [], fixture.runner))).toThrow(
      'Native input diff failed (128)',
    );
    expect(fixture.worktrees).toEqual([]);
  });

  it('sanitizes foreign binary settings without mutating the input environment', () => {
    const environment = {
      BOARDSESH_APP_VARIANT: 'other',
      EXPO_UPDATES_FINGERPRINT_OVERRIDE: SHARED_FINGERPRINT,
      BOARDSESH_WEB: '1',
      GOOGLE_MAPS_API_KEY: 'other-binary-key',
      EXPO_PUBLIC_WEB_URL: 'https://custom.example',
    };
    const devEnvironment = devFingerprintEnvironment(environment);
    expect(devEnvironment.BOARDSESH_APP_VARIANT).toBe('dev');
    expect(devEnvironment.EXPO_PUBLIC_WEB_URL).toBe('https://custom.example');
    expect(devEnvironment).not.toHaveProperty('EXPO_UPDATES_FINGERPRINT_OVERRIDE');
    expect(devEnvironment).not.toHaveProperty('GOOGLE_MAPS_API_KEY');
    expect(environment.BOARDSESH_APP_VARIANT).toBe('other');
    expect(environment.GOOGLE_MAPS_API_KEY).toBe('other-binary-key');
  });
});
