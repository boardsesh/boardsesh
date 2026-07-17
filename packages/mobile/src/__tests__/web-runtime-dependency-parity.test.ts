import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type PackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function readJson<Contents>(relativePath: string): Contents {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8')) as Contents;
}

describe('isolated Expo web runtime dependency parity', () => {
  const mobileManifest = readJson<PackageManifest>('../../package.json');
  const webRuntimeManifest = readJson<PackageManifest>('../../web-runtime/package.json');
  const expoBundledVersions = readJson<Record<string, string>>('../../node_modules/expo/bundledNativeModules.json');
  const mobileDependencyVersions = {
    ...mobileManifest.dependencies,
    ...mobileManifest.devDependencies,
  };

  it.each(['react', 'react-dom', 'react-native', 'react-native-gesture-handler', 'react-native-reanimated'])(
    'keeps %s aligned with the mobile app',
    (dependencyName) => {
      expect(webRuntimeManifest.dependencies?.[dependencyName]).toBe(mobileDependencyVersions[dependencyName]);
    },
  );

  it('keeps React Native Web aligned with the installed Expo SDK', () => {
    expect(webRuntimeManifest.dependencies?.['react-native-web']).toBe(expoBundledVersions['react-native-web']);
  });
});
