import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  parseScreenshotAppCacheKey,
  screenshotAppCacheKey,
  sdkAtLeast,
  validateScreenshotAppMetadata,
  type ScreenshotAppCacheIdentity,
  type ScreenshotAppMetadata,
} from '../ios-screenshot-app-cache';

const identity: ScreenshotAppCacheIdentity = {
  os: 'macOS',
  arch: 'ARM64',
  xcodeBuild: '27A9275',
  sdkVersion: '27.1',
  sdkBuild: '24A94232',
  nativeHash: 'f'.repeat(64),
};
const metadata: ScreenshotAppMetadata = {
  xcodeBuild: '27A9275',
  sdkName: 'iphonesimulator27.1',
  sdkBuild: '24A94232',
  platformName: 'iphonesimulator',
  supportedPlatforms: ['iPhoneSimulator'],
  executable: 'Boardsesh',
  bundleIdentifier: 'com.boardsesh.app',
  launcherUrl: 'http://localhost:8081',
  executableArchitectures: ['arm64'],
  debugArchitectures: ['arm64'],
  hasDebugLibrary: true,
  hasEmbeddedBundle: false,
};
const oldIdentity: ScreenshotAppCacheIdentity = {
  ...identity,
  xcodeBuild: '17F113',
  sdkVersion: '26.5',
  sdkBuild: '23F81a',
};
const oldMetadata: ScreenshotAppMetadata = {
  ...metadata,
  xcodeBuild: '17F113',
  sdkName: 'iphonesimulator26.5',
  sdkBuild: '23F81a',
};

describe('toolchain-aware Debug screenshot cache', () => {
  it('is deterministic and round trips the producer identity', () => {
    const key = screenshotAppCacheKey(identity);
    expect(key).toBe(screenshotAppCacheKey({ ...identity }));
    expect(parseScreenshotAppCacheKey(key)).toEqual(identity);
    expect(key).toContain('-v2-Debug-27A9275-27.1-24A94232-');
  });
  it.each([
    { xcodeBuild: '27A9999' },
    { sdkVersion: '27.2' },
    { sdkBuild: '24A99999' },
    { nativeHash: 'a'.repeat(64) },
  ])('separates a changed build input %j', (changedInput) => {
    expect(screenshotAppCacheKey({ ...identity, ...changedInput })).not.toBe(screenshotAppCacheKey(identity));
  });
  it('never accepts the old toolchain-blind namespace or a Release key', () => {
    expect(() => parseScreenshotAppCacheKey(`macOS-ARM64-screenshot-sim-app-v1-${'a'.repeat(64)}`)).toThrow('v2 Debug');
    expect(() => parseScreenshotAppCacheKey(screenshotAppCacheKey(identity).replace('-Debug-', '-Release-'))).toThrow(
      'v2 Debug',
    );
    expect(() => screenshotAppCacheKey({ ...identity, arch: 'X64' })).toThrow('ARM64');
  });
  it('validates the product against the producer rather than the consumer default compiler', () => {
    expect(() => validateScreenshotAppMetadata(oldMetadata, oldIdentity)).not.toThrow();
    expect(() => validateScreenshotAppMetadata(metadata, identity, '27.1')).not.toThrow();
  });
  it('rejects an otherwise matching SDK26.5 product for Duo', () => {
    expect(() => validateScreenshotAppMetadata(oldMetadata, oldIdentity, '27.1')).toThrow(
      'requires simulator SDK 27.1',
    );
  });
  it.each([{ xcodeBuild: '17F113' }, { sdkName: 'iphonesimulator26.5' }, { sdkBuild: '23F81a' }])(
    'rejects a restored product whose compiler or SDK mismatches its key %j',
    (changedMetadata) => {
      expect(() => validateScreenshotAppMetadata({ ...metadata, ...changedMetadata }, identity)).toThrow(
        'does not match',
      );
    },
  );
  it.each([
    { platformName: 'iphoneos' },
    { supportedPlatforms: ['iPhoneOS'] },
    { executableArchitectures: ['x86_64'] },
    { debugArchitectures: [] },
    { hasDebugLibrary: false },
    { hasEmbeddedBundle: true },
    { launcherUrl: undefined },
    { bundleIdentifier: 'another.app' },
  ])('rejects a device, Release or wrong-architecture product %j', (changedMetadata) => {
    expect(() => validateScreenshotAppMetadata({ ...metadata, ...changedMetadata }, identity)).toThrow();
  });
  it('compares SDK components numerically', () => {
    expect(sdkAtLeast('27.10', '27.2')).toBe(true);
    expect(sdkAtLeast('27.1.0', '27.1')).toBe(true);
    expect(sdkAtLeast('27.0', '27.1')).toBe(false);
    expect(() => sdkAtLeast('27.1beta', '27.1')).toThrow('Invalid');
  });
});

type Step = {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  if?: string;
};
function workflowJob(path: string, job: string): Step[] {
  const workflow = parse(readFileSync(`.github/workflows/${path}`, 'utf8')) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  return workflow.jobs[job].steps;
}
function actionSteps(path: string): Step[] {
  return (parse(readFileSync(`.github/actions/${path}/action.yml`, 'utf8')) as { runs: { steps: Step[] } }).runs.steps;
}

describe('cache boundary ordering', () => {
  const producers = [
    ['mobile-screenshots-ios.yml', 'ios-build'],
    ['mobile-e2e-gate.yml', 'ios-smoke'],
    ['mobile-store-videos-pipeline.yml', 'app'],
    ['mobile-store-videos-measure.yml', 'record'],
  ];
  it('uses one native hash recipe and computes the selected toolchain before every lookup', () => {
    const recipes = new Set<string>();
    for (const [path, job] of producers) {
      const steps = workflowJob(path, job);
      const keyIndex = steps.findIndex((step) => step.id === 'appkey');
      const restoreIndex = steps.findIndex((step) => step.uses === 'actions/cache/restore@v4');
      expect(keyIndex, path).toBeGreaterThan(-1);
      expect(keyIndex, path).toBeLessThan(restoreIndex);
      expect(steps[keyIndex].run, path).toContain('ios-screenshot-app-cache.ts key');
      recipes.add(steps[keyIndex].env!.NATIVE_INPUT_HASH);
      expect(steps[restoreIndex].with?.key, path).toBe('${{ steps.appkey.outputs.key }}');
      expect(steps[restoreIndex].with, path).not.toHaveProperty('restore-keys');
    }
    expect(recipes.size).toBe(1);
  });
  it('selects the screenshot compiler before key creation and enforces the proven SDK floor', () => {
    const steps = workflowJob('mobile-screenshots-ios.yml', 'ios-build');
    const selectIndex = steps.findIndex(
      (step) => step.run === 'bash .boardsesh/cache-tooling/scripts/select-screenshot-xcode.sh',
    );
    const keyIndex = steps.findIndex((step) => step.id === 'appkey');
    expect(selectIndex).toBeGreaterThan(-1);
    expect(selectIndex).toBeLessThan(keyIndex);
    expect(steps[keyIndex].run).toContain('--minimum-sdk 27.1');
    const selector = readFileSync('scripts/select-screenshot-xcode.sh', 'utf8');
    expect(selector).toContain('export DEVELOPER_DIR=');
    expect(selector).not.toContain('xcode-select --switch');
  });
  it('checks every built product before saving it', () => {
    for (const [path, job] of producers) {
      const steps = workflowJob(path, job);
      const validateIndex = steps.findIndex((step) => step.name === 'Verify simulator app identity');
      const saveIndex = steps.findIndex((step) => step.uses === 'actions/cache/save@v4');
      expect(validateIndex, path).toBeGreaterThan(
        steps.findIndex((step) => step.run?.includes('mobile:build-sim-app')),
      );
      expect(validateIndex, path).toBeLessThan(saveIndex);
      expect(steps[validateIndex].run, path).toContain('ios-screenshot-app-cache.ts validate');
      expect(steps[validateIndex].env?.APP_CACHE_KEY, path).toBe('${{ steps.appkey.outputs.key }}');
      if (path.includes('measure')) expect(steps[validateIndex].if).toBeUndefined();
    }
  });
  it.each(['ios-screenshot-shard', 'ios-store-video-tools'])(
    'checks a restored product before %s can install or capture it',
    (action) => {
      const steps = actionSteps(action);
      const restoreIndex = steps.findIndex((step) => step.uses === 'actions/cache/restore@v4');
      const validateIndex = steps.findIndex((step) => step.name === 'Verify prebuilt simulator app identity');
      expect(validateIndex).toBeGreaterThan(restoreIndex);
      expect(validateIndex).toBeLessThan(
        steps.findIndex((step) => step.name?.startsWith('Install pinned Maestro') || step.name === 'Install Maestro'),
      );
      expect(steps[validateIndex].run).toContain('ios-screenshot-app-cache.ts" validate');
      expect(steps[validateIndex].env?.APP_CACHE_KEY).toBe('${{ inputs.app-cache-key }}');
      if (action === 'ios-screenshot-shard') {
        expect(steps[validateIndex].env?.MINIMUM_SDK).toBe("${{ inputs.device-slug == 'iphone-duo' && '27.1' || '' }}");
        expect(steps[validateIndex].run).toContain('--minimum-sdk');
      }
    },
  );
});

describe('historical application source with current cache tooling', () => {
  const fixtures = 'scripts/__tests__/fixtures/historical-screenshot-cache';
  const sourceManifest = JSON.parse(readFileSync(`${fixtures}/source.json`, 'utf8')) as {
    sourceSha: string;
    files: Record<string, string>;
  };
  const toolingFiles = [
    'scripts/ios-screenshot-app-cache.ts',
    'scripts/select-screenshot-xcode.sh',
    '.github/actions/ios-screenshot-shard/action.yml',
    '.github/actions/ios-store-video-tools/action.yml',
  ];
  function runGit(directory: string, args: string[]): string {
    const result = spawnSync('git', ['-C', directory, ...args], {
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  }
  function commitFixture(directory: string): string {
    runGit(directory, ['init', '--quiet']);
    runGit(directory, ['add', '--all']);
    runGit(directory, [
      '-c',
      'user.name=Cache fixture',
      '-c',
      'user.email=cache-fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'Fixture identity',
    ]);
    return runGit(directory, ['rev-parse', 'HEAD']);
  }
  it('runs the real workflow key command when the requested historical source lacks new helpers', () => {
    const directory = mkdtempSync(join(tmpdir(), 'boardsesh-historical-cache-'));
    try {
      const source = join(directory, 'source');
      mkdirSync(source);
      for (const [name, expectedHash] of Object.entries(sourceManifest.files)) {
        const contents = readFileSync(join(fixtures, name));
        expect(createHash('sha256').update(contents).digest('hex')).toBe(expectedHash);
        mkdirSync(dirname(join(source, name)), { recursive: true });
        writeFileSync(join(source, name), contents);
      }
      expect(sourceManifest.sourceSha).toBe('6e8c46f203385c6587dcf2669e29df1c9d611cf8');
      const applicationHead = commitFixture(source);
      expect(existsSync(join(source, 'scripts/ios-screenshot-app-cache.ts'))).toBe(false);
      expect(existsSync(join(source, 'scripts/select-screenshot-xcode.sh'))).toBe(false);
      const tooling = join(source, '.boardsesh/cache-tooling');
      for (const name of toolingFiles) {
        mkdirSync(dirname(join(tooling, name)), { recursive: true });
        writeFileSync(join(tooling, name), readFileSync(name));
      }
      const toolingHead = commitFixture(tooling);
      const bin = join(directory, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'xcodebuild'), '#!/bin/sh\nprintf "Xcode 27.1\\nBuild version 27A9275\\n"\n', {
        mode: 0o755,
      });
      writeFileSync(
        join(bin, 'xcrun'),
        '#!/bin/sh\ncase "$3" in\n  --show-sdk-version) echo 27.1 ;;\n  --show-sdk-build-version) echo 24A94232 ;;\n  *) exit 1 ;;\nesac\n',
        { mode: 0o755 },
      );
      const mockPlatform = join(directory, 'mock-platform.mjs');
      writeFileSync(mockPlatform, "Object.defineProperty(process, 'platform', { value: 'darwin' });\n");
      const output = join(directory, 'github-output');
      const steps = workflowJob('mobile-screenshots-ios.yml', 'ios-build');
      const receipt = steps.find((step) => step.name === 'Verify application and cache tooling identities')!;
      const key = steps.find((step) => step.id === 'appkey')!;
      const environment = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        NODE_OPTIONS: `--import=${pathToFileURL(mockPlatform).href}`,
        RUNNER_OS: 'macOS',
        RUNNER_ARCH: 'ARM64',
        NATIVE_INPUT_HASH: identity.nativeHash,
        GITHUB_OUTPUT: output,
        APP_SOURCE_SHA: applicationHead,
        CACHE_TOOLING_SHA: toolingHead,
      };
      const receiptResult = spawnSync('bash', ['-c', receipt.run!], {
        cwd: source,
        env: environment,
        encoding: 'utf8',
        timeout: 15000,
      });
      expect(receiptResult.status, receiptResult.stderr).toBe(0);
      expect(receiptResult.stdout).toContain(applicationHead);
      expect(receiptResult.stdout).toContain(toolingHead);
      const wrongSource = spawnSync('bash', ['-c', receipt.run!], {
        cwd: source,
        env: { ...environment, APP_SOURCE_SHA: 'a'.repeat(40) },
        encoding: 'utf8',
        timeout: 15000,
      });
      expect(wrongSource.status).toBe(1);
      const result = spawnSync('bash', ['-c', key.run!], {
        cwd: source,
        env: environment,
        encoding: 'utf8',
        timeout: 15000,
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(readFileSync(output, 'utf8')).toContain(`key=${screenshotAppCacheKey(identity)}`);
      expect(runGit(source, ['rev-parse', 'HEAD'])).toBe(applicationHead);
      expect(runGit(source, ['status', '--porcelain'])).toBe('');
      for (const [name, expectedHash] of Object.entries(sourceManifest.files))
        expect(
          createHash('sha256')
            .update(readFileSync(join(source, name)))
            .digest('hex'),
        ).toBe(expectedHash);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('delivers immutable tooling before every producer and consumer without replacing application source', () => {
    const jobs = [
      ['mobile-screenshots-ios.yml', 'ios-build'],
      ['mobile-screenshots-ios.yml', 'probe'],
      ['mobile-screenshots-ios.yml', 'ios-capture'],
      ['mobile-screenshots-ios.yml', 'cpp-capture'],
      ['mobile-e2e-gate.yml', 'ios-smoke'],
      ['mobile-store-videos-pipeline.yml', 'app'],
      ['mobile-store-videos-pipeline.yml', 'record'],
      ['mobile-store-videos-pipeline.yml', 'crew'],
      ['mobile-store-videos-measure.yml', 'record'],
    ];
    for (const [path, job] of jobs) {
      const steps = workflowJob(path, job);
      const checkouts = steps.filter((step) => step.uses === 'actions/checkout@v4');
      expect(checkouts).toHaveLength(2);
      expect(checkouts[0].with ?? {}).not.toHaveProperty('path');
      expect(checkouts[1].with?.path).toBe('.boardsesh/cache-tooling');
      expect(checkouts[1].with?.ref).toBe('${{ github.workflow_sha }}');
      expect(checkouts[1].with?.['persist-credentials']).toBe(false);
      const selectedPaths = String(checkouts[1].with?.['sparse-checkout']).trim().split('\n');
      expect(selectedPaths).toEqual(toolingFiles);
      const receiptIndex = steps.findIndex((step) => step.name === 'Verify application and cache tooling identities');
      expect(receiptIndex).toBeGreaterThan(steps.indexOf(checkouts[1]));
      const boundary = steps.findIndex(
        (step) => step.id === 'appkey' || step.uses?.startsWith('./.boardsesh/cache-tooling/.github/actions/'),
      );
      expect(receiptIndex, `${path}/${job}`).toBeLessThan(boundary);
      expect(steps[receiptIndex].env?.APP_SOURCE_SHA).toBe(checkouts[0].with?.ref ?? '${{ github.sha }}');
      expect(steps[receiptIndex].env?.CACHE_TOOLING_SHA).toBe('${{ github.workflow_sha }}');
      if (steps[boundary].id === 'appkey') {
        expect(steps[boundary].run).toContain('.boardsesh/cache-tooling/scripts/ios-screenshot-app-cache.ts');
        expect(steps[boundary].env?.NATIVE_INPUT_HASH).toContain(
          "'.boardsesh/cache-tooling/scripts/ios-screenshot-app-cache.ts'",
        );
      }
    }
    for (const action of ['ios-screenshot-shard', 'ios-store-video-tools']) {
      const validator = actionSteps(action).find((step) => step.name === 'Verify prebuilt simulator app identity');
      expect(validator?.env?.CACHE_TOOLING_ROOT).toBe('${{ github.action_path }}/../../..');
      expect(validator?.run).toContain('"$CACHE_TOOLING_ROOT/scripts/ios-screenshot-app-cache.ts"');
    }
  });
});
