import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { APP_CONFIG_PATH } from './lib/mobile-release-version';
import { nativeReleaseMessage, NATIVE_BASELINE_TAG } from './lib/native-release';
import { prepareNativeVersionRestoration, prepareNativeVersionStamp, writeNativeStamp } from './mobile-native-release';
import { classifyUnreleasedNativeOta } from './mobile-ota-unreleased-native';
import { candidateFixture } from './__tests__/helpers/ota-stable-fixtures';

const fingerprints = { ios: 'a'.repeat(40), android: 'b'.repeat(40) };
const oldFingerprints = { ios: 'e'.repeat(40), android: 'f'.repeat(40) };
const now = Date.parse('2026-11-01T20:00:00Z');
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(kind: 'bump' | 'adoption' | 'restoration' = 'bump') {
  const directory = mkdtempSync(join(tmpdir(), 'ota-unreleased-'));
  directories.push(directory);
  const git = (args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  git(['init', '--quiet']);
  git(['config', 'user.name', 'Tester']);
  git(['config', 'user.email', 'tester@example.com']);
  mkdirSync(join(directory, 'packages/mobile'), { recursive: true });
  const writeVersion = (version: string) =>
    writeFileSync(join(directory, APP_CONFIG_PATH), `export default {\n  version: '${version}',\n};\n`);
  writeVersion('2.6.0');
  git(['add', '.']);
  git(['commit', '--quiet', '-m', 'baseline']);
  const baselineSha = git(['rev-parse', 'HEAD']);
  git([
    'tag',
    '-a',
    NATIVE_BASELINE_TAG,
    '-m',
    nativeReleaseMessage({ ...oldFingerprints, sourceSha: baselineSha }, 'baseline'),
  ]);
  // The live stores below offer 2.6.0, so its approval anchor exists and closes that version.
  const publicAnchor = { tag: `release/ios-v2.6.0-${oldFingerprints.ios.slice(0, 12)}`, sha: baselineSha };
  git(['tag', publicAnchor.tag, baselineSha]);
  if (kind !== 'bump') writeVersion('2.7.0');
  writeFileSync(join(directory, 'native.txt'), 'new native pair');
  git(['add', '.']);
  git(['commit', '--quiet', '-m', 'native change']);
  const rawSource = git(['rev-parse', 'HEAD']);
  // A restoration line undoes the pre-fix coordinator's extra bump of the open 2.7.0.
  let stamp =
    kind === 'restoration'
      ? writeNativeStamp(directory, rawSource, fingerprints, '2.7.1', 'version-bump')
      : prepareNativeVersionStamp(directory, rawSource, fingerprints, '2.6.0', [publicAnchor]);
  git(['update-ref', 'HEAD', stamp.sha]);
  if (kind === 'restoration') {
    stamp = prepareNativeVersionRestoration(directory, stamp.sha, '2.7.0', stamp.sha, fingerprints).stamp;
    git(['update-ref', 'HEAD', stamp.sha]);
  }
  writeFileSync(join(directory, 'main.js'), 'JS update after native stamp');
  git(['add', '.']);
  git(['commit', '--quiet', '-m', 'JS only']);
  const sourceSha = git(['rev-parse', 'HEAD']);
  const stagePath = join(directory, 'stage');
  mkdirSync(stagePath);
  const receipt = candidateFixture().receipt;
  receipt.commitHash = sourceSha;
  for (const platform of ['ios', 'android'] as const) {
    const root = join(stagePath, platform);
    mkdirSync(root);
    const bundle = `${platform} JS update`;
    receipt.platforms[platform].runtimeVersion = fingerprints[platform];
    receipt.platforms[platform].bundleSha256 = createHash('sha256').update(bundle).digest('hex');
    writeFileSync(join(root, 'bundle.js'), bundle);
    writeFileSync(
      join(root, 'metadata.json'),
      JSON.stringify({
        version: 0,
        bundler: 'metro',
        fileMetadata: { [platform]: { bundle: 'bundle.js', assets: [] } },
      }),
    );
    writeFileSync(
      join(root, 'expoConfig.json'),
      JSON.stringify({
        version: stamp.version,
        runtimeVersion: fingerprints[platform],
        updates: { requestHeaders: { 'expo-app-id': 'a1111111-1111-4111-8111-111111111111' } },
      }),
    );
  }
  writeFileSync(join(stagePath, 'receipt.json'), JSON.stringify(receipt));
  const live = {
    schemaVersion: 1,
    checkedAt: new Date(now).toISOString(),
    ...Object.fromEntries(
      (['ios', 'android'] as const).map((platform) => [
        platform,
        {
          version: '2.6.0',
          buildNumber: 1,
          runtimeVersion: oldFingerprints[platform],
          protectedRuntimeVersions: [oldFingerprints[platform]],
          buildTag: `build-${platform}-v2.6.0-1-${oldFingerprints[platform].slice(0, 12)}`,
          commit: baselineSha,
        },
      ]),
    ),
  } as {
    schemaVersion: number;
    checkedAt: string;
    ios: {
      version: string;
      buildNumber: number;
      runtimeVersion: string;
      protectedRuntimeVersions: string[];
      buildTag: string;
      commit: string;
    };
    android: {
      version: string;
      buildNumber: number;
      runtimeVersion: string;
      protectedRuntimeVersions: string[];
      buildTag: string;
      commit: string;
    };
  };
  const options = { directory, sourceSha, mainSha: sourceSha, stagePath, liveStoreRuntimes: live, now };
  return { directory, git, stamp, receipt, live, options, writeVersion, rawSource };
}

describe('immediate unreleased-native OTA admission', () => {
  it.each(['bump', 'adoption', 'restoration'] as const)(
    'admits JS updates on a validated %s line, with newer JS on main',
    (kind) => {
      const repository = fixture(kind);
      writeFileSync(join(repository.directory, 'later.js'), 'later JS');
      repository.git(['add', 'later.js']);
      repository.git(['commit', '--quiet', '-m', 'newer JS']);
      expect(
        classifyUnreleasedNativeOta({ ...repository.options, mainSha: repository.git(['rev-parse', 'HEAD']) }),
      ).toMatchObject({ eligible: true, stampSha: repository.stamp.sha });
    },
  );

  it.each(['ios', 'android'] as const)(
    'holds once %s publicly offers the marketing version, even with another runtime',
    (platform) => {
      const repository = fixture();
      repository.live[platform].version = repository.stamp.version;
      repository.live[platform].buildTag =
        `build-${platform}-v${repository.stamp.version}-1-${oldFingerprints[platform].slice(0, 12)}`;
      expect(classifyUnreleasedNativeOta(repository.options)).toMatchObject({ eligible: false });
    },
  );

  it('holds if a candidate runtime is publicly offered under an older marketing version', () => {
    const repository = fixture();
    repository.live.android.protectedRuntimeVersions.push(fingerprints.android);
    expect(classifyUnreleasedNativeOta(repository.options)).toMatchObject({ eligible: false });
  });

  it('holds runtime overlap in the opposite platform public evidence', () => {
    const repository = fixture();
    repository.live.android.protectedRuntimeVersions.push(fingerprints.ios);
    expect(classifyUnreleasedNativeOta(repository.options)).toMatchObject({ eligible: false });
  });

  it('protects historical public runtimes after the stores offer newer different binaries', () => {
    const repository = fixture();
    repository.git(['tag', `release/ios-v2.5.0-${fingerprints.ios.slice(0, 12)}`]);
    expect(classifyUnreleasedNativeOta(repository.options)).toMatchObject({ eligible: false });
  });

  it('holds a public approval anchor even before both stores offer it', () => {
    const repository = fixture();
    repository.git(['tag', `release/ios-v${repository.stamp.version}-${fingerprints.ios.slice(0, 12)}`]);
    expect(classifyUnreleasedNativeOta(repository.options)).toMatchObject({ eligible: false });
  });

  it('fails closed for stale or malformed store evidence', () => {
    const repository = fixture();
    repository.live.checkedAt = new Date(now - 7 * 60 * 60 * 1000).toISOString();
    expect(() => classifyUnreleasedNativeOta(repository.options)).toThrow('stale');
    expect(() => classifyUnreleasedNativeOta({ ...repository.options, liveStoreRuntimes: {} })).toThrow();
  });

  it('holds an unstamped native runtime and rejects an altered archive/source', () => {
    const repository = fixture();
    repository.receipt.platforms.ios.runtimeVersion = 'c'.repeat(40);
    writeFileSync(join(repository.options.stagePath, 'receipt.json'), JSON.stringify(repository.receipt));
    const configPath = join(repository.options.stagePath, 'ios/expoConfig.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(configPath, JSON.stringify({ ...config, runtimeVersion: 'c'.repeat(40) }));
    expect(classifyUnreleasedNativeOta(repository.options)).toMatchObject({ eligible: false });
    expect(() => classifyUnreleasedNativeOta({ ...repository.options, sourceSha: repository.rawSource })).toThrow(
      'pinned source',
    );
    writeFileSync(join(repository.options.stagePath, 'ios/bundle.js'), 'tampered');
    expect(() => classifyUnreleasedNativeOta(repository.options)).toThrow('SHA-256');
  });

  it('holds when current main has another native stamp or an unstamped marketing version', () => {
    const repository = fixture();
    repository.writeVersion('3.0.0');
    repository.git(['add', APP_CONFIG_PATH]);
    repository.git(['commit', '--quiet', '-m', 'version ahead of coordinator']);
    const current = repository.git(['rev-parse', 'HEAD']);
    expect(classifyUnreleasedNativeOta({ ...repository.options, mainSha: current })).toMatchObject({ eligible: false });
    const next = prepareNativeVersionStamp(
      repository.directory,
      current,
      { ios: 'c'.repeat(40), android: 'd'.repeat(40) },
      repository.stamp.version,
      [],
    );
    expect(classifyUnreleasedNativeOta({ ...repository.options, mainSha: next.sha })).toMatchObject({
      eligible: false,
    });
  });
});

it('keeps backend/schema/server gates, exact bytes, and re-admission inside the production lock', () => {
  const workflow = parse(readFileSync('.github/workflows/production-deploy.yml', 'utf8')) as {
    jobs: Record<
      string,
      {
        if: string;
        needs: string[];
        environment: string;
        concurrency?: { group: string };
        steps: { name?: string; if?: string; run?: string; env?: Record<string, string> }[];
      }
    >;
  };
  const admission = workflow.jobs['unreleased-native-ota'];
  const promotion = workflow.jobs['promote-mobile-ota'];
  expect(admission.if).toContain("vars.OTA_STABLE_RELEASE_ENABLED == 'true'");
  expect(admission.if).toContain("needs.detect-changes.outputs.critical_ota != 'true'");
  expect(admission.environment).toBe('Production');
  expect(admission.steps.some((step) => /\b(?:install|vp|pnpm|npm)\b/.test(step.run ?? ''))).toBe(false);
  expect(promotion.if).toContain("needs.unreleased-native-ota.outputs.eligible == 'true'");
  expect(promotion.needs).toEqual(
    expect.arrayContaining(['build-web', 'build-backend', 'migrate', 'deploy-production-backend']),
  );
  expect(promotion.concurrency?.group).toBe('mobile-ota-production');
  const names = promotion.steps.map((step) => step.name);
  const recheckIndex = names.indexOf('Recheck unreleased native admission before publication');
  expect(recheckIndex).toBeGreaterThan(names.indexOf('Require live backend schema'));
  expect(recheckIndex).toBeGreaterThan(names.indexOf('Wait for the OTA server rollout on this commit'));
  expect(recheckIndex).toBeLessThan(names.indexOf('Promote exact staged iOS and Android exports'));
  expect(promotion.steps[recheckIndex].run).toContain('--require-eligible');
  expect(promotion.steps[recheckIndex].run).toContain('scripts/mobile-live-store-runtimes.ts');
  const promote = promotion.steps.find((step) => step.name === 'Promote exact staged iOS and Android exports');
  expect(promote?.run).toContain('--receipt ota-stage/receipt.json');
  expect(promote?.run).not.toContain('--rollout-percentage');
  const critical = promotion.steps.find((step) => step.name === 'Release critical staged bytes to 100% stable');
  expect(critical?.if).toBe("needs.detect-changes.outputs.critical_ota == 'true'");
});
