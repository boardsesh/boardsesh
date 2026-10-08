import { createRequire } from 'node:module';
import { describe, expect, it } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { filterWebStartupModules } = require('../../metro-web-startup-modules.cjs') as {
  filterWebStartupModules: (modulePaths: readonly string[]) => string[];
};

describe('web startup modules', () => {
  it('removes the native bridge initializer while retaining Expo polyfill and runtime order', () => {
    const startup = [
      '/app/node_modules/react-native/Libraries/Core/InitializeCore.js',
      '/app/node_modules/expo/src/winter/index.ts',
      '/app/node_modules/@expo/metro-runtime/src/index.ts',
    ];
    expect(filterWebStartupModules(startup)).toEqual(startup.slice(1));
    expect(startup).toHaveLength(3);
  });

  it('handles Windows paths without removing unrelated initializers', () => {
    const native = 'C:\\app\\node_modules\\react-native\\Libraries\\Core\\InitializeCore.js';
    const unrelated = '/app/node_modules/another-runtime/Libraries/Core/InitializeCore.js';
    expect(filterWebStartupModules([native, unrelated])).toEqual([unrelated]);
  });
});
