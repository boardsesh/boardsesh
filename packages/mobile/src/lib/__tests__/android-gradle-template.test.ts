import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { ConfigContext } from 'expo/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import createExpoConfig from '../../../app.config';

const require = createRequire(import.meta.url);

afterEach(() => vi.unstubAllEnvs());

describe('Expo Android build toolchain', () => {
  it('lets Expo local modules inherit the app compile SDK required by native dependencies', () => {
    const mobileRoot = fileURLToPath(new URL('../../..', import.meta.url));
    const modulesRoot = join(mobileRoot, 'modules');
    const moduleBuildFiles = readdirSync(modulesRoot)
      .map((moduleName) => join(modulesRoot, moduleName, 'android/build.gradle'))
      .filter((buildFile) => existsSync(buildFile));
    moduleBuildFiles.push(join(mobileRoot, '../../scripts/fixtures/mobile-profile/native/android/build.gradle'));
    expect(moduleBuildFiles.length).toBeGreaterThan(0);
    for (const buildFile of moduleBuildFiles) {
      const gradleSource = readFileSync(buildFile, 'utf8');
      expect(gradleSource, buildFile).toContain("id 'expo-module-gradle-plugin'");
      expect(gradleSource, buildFile).not.toMatch(/\bcompileSdk(?:Version)?\s*(?:=\s*)?\d+/);
    }
  });

  it('keeps Expo in control of the wrapper instead of downgrading its Gradle runtime', () => {
    vi.stubEnv('TAILSCALE_HOSTS', '');
    const config = createExpoConfig({
      config: { name: 'Boardsesh', slug: 'boardsesh' },
      projectRoot: fileURLToPath(new URL('../../..', import.meta.url)),
    } as ConfigContext);
    const pluginNames = config.plugins?.map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin));
    expect(pluginNames).not.toContain('./plugins/with-android-gradle-wrapper-version');
  });

  it('ships a compatible wrapper with its download safeguards and cache locations', async () => {
    const expoRequire = createRequire(require.resolve('@expo/cli/package.json'));
    const tar = expoRequire('tar') as {
      list: (options: { file: string; onReadEntry: (entry: Readable & { path: string }) => void }) => Promise<unknown>;
    };
    let wrapper = '';
    await tar.list({
      file: join(dirname(require.resolve('expo/package.json')), 'template.tgz'),
      onReadEntry(entry) {
        if (entry.path !== 'package/android/gradle/wrapper/gradle-wrapper.properties') {
          entry.resume();
          return;
        }
        entry.on('data', (chunk: Buffer) => {
          wrapper += chunk.toString('utf8');
        });
      },
    });
    const version = wrapper
      .match(/gradle-(\d+)\.(\d+)\.(\d+)-bin\.zip/)
      ?.slice(1)
      .map(Number);
    expect(version, 'The installed Expo template must contain a Gradle binary distribution').toBeDefined();
    if (!version) throw new Error('Missing Expo Gradle wrapper version');
    // AGP 9.2.1, used by RN 0.88, rejects anything below Gradle 9.4.1.
    const [major, minor, patch] = version;
    expect(major > 9 || (major === 9 && (minor > 4 || (minor === 4 && patch >= 1)))).toBe(true);
    expect(wrapper).toContain('networkTimeout=10000');
    expect(wrapper).toContain('validateDistributionUrl=true');
    expect(wrapper).toContain('distributionBase=GRADLE_USER_HOME');
    expect(wrapper).toContain('distributionPath=wrapper/dists');
    expect(wrapper).toContain('zipStoreBase=GRADLE_USER_HOME');
    expect(wrapper).toContain('zipStorePath=wrapper/dists');
  });
});
