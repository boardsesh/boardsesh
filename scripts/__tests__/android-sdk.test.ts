import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureAndroidSdk } from '../lib/android-sdk';
import { runInherit } from '../lib/exec';

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
  it('installs the Expo compile SDK and build tools without downloading an emulator for builds', () => {
    const home = installedSdkTools();

    ensureAndroidSdk({ buildOnly: true, includeBuildTools: true });

    expect(runInherit).toHaveBeenCalledExactlyOnceWith(
      join(home, 'cmdline-tools/latest/bin/sdkmanager'),
      [`--sdk_root=${home}`, 'platforms;android-37', 'build-tools;37.0.0'],
      expect.objectContaining({ env: expect.objectContaining({ ANDROID_HOME: home }) }),
    );
  });

  it('preserves the existing Android 36 emulator image alongside the newer compile SDK', () => {
    const home = installedSdkTools();

    ensureAndroidSdk();

    expect(runInherit).toHaveBeenCalledExactlyOnceWith(
      join(home, 'cmdline-tools/latest/bin/sdkmanager'),
      [`--sdk_root=${home}`, 'emulator', 'platforms;android-37', 'system-images;android-36;google_apis;x86_64'],
      expect.objectContaining({ env: expect.objectContaining({ ANDROID_HOME: home }) }),
    );
  });
});
