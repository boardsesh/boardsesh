import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { resolveWebRuntimeModulePath } = require('../../metro-web-runtime-resolution.cjs') as {
  resolveWebRuntimeModulePath: (runtimeModules: Record<string, string>, moduleName: string) => string | null;
};

const gorhomModuleId = ['@gorhom', 'bottom-sheet'].join('/');
const gorhomRuntimeRoot = `/runtime/${gorhomModuleId}`;
const runtimeModules = {
  [gorhomModuleId]: gorhomRuntimeRoot,
  'react-native-web': '/runtime/react-native-web',
};

describe('resolveWebRuntimeModulePath', () => {
  it('redirects an exact package specifier to the isolated runtime', () => {
    expect(resolveWebRuntimeModulePath(runtimeModules, 'react-native-web')).toBe('/runtime/react-native-web');
  });

  it('preserves a package subpath under the isolated runtime root', () => {
    expect(resolveWebRuntimeModulePath(runtimeModules, 'react-native-web/dist/index')).toBe(
      join('/runtime/react-native-web', 'dist/index'),
    );
  });

  it('preserves scoped-package subpaths', () => {
    expect(resolveWebRuntimeModulePath(runtimeModules, `${gorhomModuleId}/components`)).toBe(
      join(gorhomRuntimeRoot, 'components'),
    );
  });

  it('leaves unrelated and similarly prefixed packages alone', () => {
    expect(resolveWebRuntimeModulePath(runtimeModules, 'react-native-webview')).toBeNull();
    expect(resolveWebRuntimeModulePath(runtimeModules, 'expo-router')).toBeNull();
  });
});
