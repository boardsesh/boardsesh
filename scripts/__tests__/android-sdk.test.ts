import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { ensureAndroidSdk } from '../lib/android-sdk';
import { runCapture, runInherit } from '../lib/exec';

vi.mock('../lib/exec', () => ({
  commandExists: vi.fn(() => true),
  runCapture: vi.fn(() => ({ status: 0, stdout: 'openjdk version "21.0.1"', stderr: '' })),
  runInherit: vi.fn(() => 0),
}));

const temporaryRoots: string[] = [];

function installedSdkTools(): string {
  const root = mkdtempSync(join(tmpdir(), 'boardsesh-sdk-test-'));
  temporaryRoots.push(root);
  for (const relative of ['platform-tools/adb', 'cmdline-tools/latest/bin/sdkmanager', 'jdk/bin/java']) {
    const filePath = join(root, relative);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, '');
  }
  writeFileSync(join(root, 'cmdline-tools/latest/source.properties'), 'Pkg.Revision=23.0\n');
  vi.stubEnv('ANDROID_HOME', root);
  vi.stubEnv('JAVA_HOME', join(root, 'jdk'));
  return root;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Android SDK provisioning', () => {
  it.each([
    '.github/actions/android-rn-setup/action.yml',
    '.github/actions/android-emulator-capture/action.yml',
    '.github/workflows/android-apk-rn.yml',
    '.github/workflows/android-apk-dev-client.yml',
  ])('uses schema-compatible tools and the exact published SDK package in %s', (workflowPath) => {
    type Step = { uses?: string; with?: Record<string, unknown>; run?: string };
    const workflow = parse(readFileSync(new URL(`../../${workflowPath}`, import.meta.url), 'utf8')) as {
      runs?: { steps: Step[] };
      jobs?: Record<string, { steps?: Step[] }>;
    };
    const steps = workflow.runs?.steps ?? Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
    const setupSteps = steps.filter((step) => step.uses === 'android-actions/setup-android@v3');
    expect(setupSteps).toHaveLength(1);
    expect(setupSteps[0]!.with).toMatchObject({ 'cmdline-tools-version': '16111833', packages: '' });
    const installCommands = steps.map((step) => step.run ?? '').join('\n');
    expect(installCommands).toContain('sdkmanager "platforms;android-37.0" "build-tools;37.0.0"');
    expect(installCommands).not.toContain('"platforms;android-37"');
  });

  it('installs the Expo compile SDK and build tools without downloading an emulator for builds', () => {
    const home = installedSdkTools();

    ensureAndroidSdk({ buildOnly: true, includeBuildTools: true });

    expect(runInherit).toHaveBeenCalledExactlyOnceWith(
      join(home, 'cmdline-tools/latest/bin/sdkmanager'),
      [`--sdk_root=${home}`, 'platforms;android-37.0', 'build-tools;37.0.0'],
      expect.objectContaining({ env: expect.objectContaining({ ANDROID_HOME: home }) }),
    );
  });

  it('preserves the existing Android 36 emulator image alongside the newer compile SDK', () => {
    const home = installedSdkTools();

    ensureAndroidSdk();

    expect(runInherit).toHaveBeenCalledExactlyOnceWith(
      join(home, 'cmdline-tools/latest/bin/sdkmanager'),
      [`--sdk_root=${home}`, 'emulator', 'platforms;android-37.0', 'system-images;android-36;google_apis;x86_64'],
      expect.objectContaining({ env: expect.objectContaining({ ANDROID_HOME: home }) }),
    );
  });

  it('upgrades cached command-line tools that cannot read the Android 37 repository schema', () => {
    const home = installedSdkTools();
    writeFileSync(join(home, 'cmdline-tools/latest/source.properties'), 'Pkg.Revision=12.0\n');
    vi.mocked(runCapture).mockImplementation((command, args) => {
      if (command === 'unzip') {
        const extractedRoot = join(args[3]!, 'cmdline-tools');
        mkdirSync(join(extractedRoot, 'bin'), { recursive: true });
        writeFileSync(join(extractedRoot, 'bin/sdkmanager'), '');
        writeFileSync(join(extractedRoot, 'source.properties'), 'Pkg.Revision=23.0\n');
      }
      return { status: 0, stdout: 'openjdk version "21.0.1"', stderr: '' };
    });

    ensureAndroidSdk({ buildOnly: true, includeBuildTools: true });

    expect(runCapture).toHaveBeenCalledWith(
      'curl',
      expect.arrayContaining(['https://dl.google.com/android/repository/commandlinetools-linux-16111833_latest.zip']),
    );
    expect(runInherit).toHaveBeenCalledExactlyOnceWith(
      join(home, 'cmdline-tools/latest/bin/sdkmanager'),
      [`--sdk_root=${home}`, 'platforms;android-37.0', 'build-tools;37.0.0'],
      expect.objectContaining({ env: expect.objectContaining({ ANDROID_HOME: home }) }),
    );
  });
});
