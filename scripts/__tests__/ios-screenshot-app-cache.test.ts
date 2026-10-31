import { readFileSync } from 'node:fs';
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
    const selectIndex = steps.findIndex((step) => step.run === 'bash scripts/select-screenshot-xcode.sh');
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
      expect(steps[validateIndex].run).toContain('ios-screenshot-app-cache.ts validate');
      expect(steps[validateIndex].env?.APP_CACHE_KEY).toBe('${{ inputs.app-cache-key }}');
      if (action === 'ios-screenshot-shard') {
        expect(steps[validateIndex].env?.MINIMUM_SDK).toBe("${{ inputs.device-slug == 'iphone-duo' && '27.1' || '' }}");
        expect(steps[validateIndex].run).toContain('--minimum-sdk');
      }
    },
  );
});
