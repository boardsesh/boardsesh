import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AndroidConfig } from 'expo/config-plugins';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const expoRequire = createRequire(require.resolve('expo/package.json'));
const autolinkingRoot = dirname(expoRequire.resolve('expo-modules-autolinking/package.json'));
const moduleRoot = fileURLToPath(new URL('../../../modules/android-app-config', import.meta.url));

type RawModuleConfig = {
  platforms: string[];
  android: { modules: string[] };
};

type ModuleConfig = {
  supportsPlatform(platform: string): boolean;
};

const { ExpoModuleConfig } = require(join(autolinkingRoot, 'build/ExpoModuleConfig.js')) as {
  ExpoModuleConfig: new (rawConfig: RawModuleConfig) => ModuleConfig;
};
const { resolveModuleAsync } = require(join(autolinkingRoot, 'build/platforms/android/android.js')) as {
  resolveModuleAsync(
    packageName: string,
    revision: { name: string; path: string; version: string; config: ModuleConfig },
  ): Promise<{
    packageName: string;
    projects: Array<{ name: string; sourceDir: string; modules: unknown[]; packages: string[] }>;
  } | null>;
};

const rawModuleConfig = JSON.parse(
  readFileSync(join(moduleRoot, 'expo-module.config.json'), 'utf8'),
) as RawModuleConfig;
const modulePackage = JSON.parse(readFileSync(join(moduleRoot, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};

describe('Android-only app manifest configuration', () => {
  it('makes portrait displays and Wi-Fi hardware optional without permissions or activity overrides', async () => {
    const { manifest } = await AndroidConfig.Manifest.readAndroidManifestAsync(
      join(moduleRoot, 'android/src/main/AndroidManifest.xml'),
    );

    expect(manifest['uses-feature']).toEqual([
      { $: { 'android:name': 'android.hardware.screen.portrait', 'android:required': 'false' } },
      { $: { 'android:name': 'android.hardware.wifi', 'android:required': 'false' } },
    ]);
    expect(manifest['uses-permission']).toBeUndefined();
    expect(manifest.application).toBeUndefined();
  });

  it('supports Android and excludes every Apple platform in the installed autolinker', () => {
    const moduleConfig = new ExpoModuleConfig(rawModuleConfig);

    expect(moduleConfig.supportsPlatform('android')).toBe(true);
    for (const platform of ['apple', 'ios', 'macos', 'tvos']) {
      expect(moduleConfig.supportsPlatform(platform)).toBe(false);
    }
  });

  it('autolinks the manifest-only Android library without runtime modules', async () => {
    const moduleConfig = new ExpoModuleConfig(rawModuleConfig);
    const descriptor = await resolveModuleAsync(modulePackage.name, {
      name: modulePackage.name,
      path: moduleRoot,
      version: modulePackage.version,
      config: moduleConfig,
    });

    expect(descriptor?.packageName).toBe('@boardsesh/android-app-config');
    expect(descriptor?.projects).toEqual([
      expect.objectContaining({
        sourceDir: join(moduleRoot, 'android'),
        modules: [],
        packages: [],
      }),
    ]);
  });
});
