import { createRequire } from 'node:module';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { resolveWebRuntimeModulePath } = require('../../metro-web-runtime-resolution.cjs') as {
  resolveWebRuntimeModulePath: (runtimeModules: Record<string, string>, moduleName: string) => string | null;
};

const gorhomModuleId = ['@gorhom', 'bottom-sheet'].join('/');
const gorhomRuntimeRoot = `/runtime/${gorhomModuleId}`;
const runtimeModules = {
  [gorhomModuleId]: gorhomRuntimeRoot,
  'react-native': '/runtime/react-native-web',
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

  it('aliases the bare native API while preserving native package metadata and private subpaths', () => {
    expect(resolveWebRuntimeModulePath(runtimeModules, 'react-native')).toBe('/runtime/react-native-web');
    expect(resolveWebRuntimeModulePath(runtimeModules, 'react-native/package.json')).toBeNull();
    expect(resolveWebRuntimeModulePath(runtimeModules, 'react-native/Libraries/Utilities/Platform')).toBeNull();
  });
});

describe('Metro browser/native resolution boundary', () => {
  const mobileRoot = join(__dirname, '../..');
  function loadMetroConfig(browserExport = false) {
    let sdkOptions: Record<string, unknown> | undefined;
    const metroModule = {
      exports: {} as {
        resolver?: { resolveRequest?: (context: unknown, moduleName: string, platform: string) => unknown };
      },
    };
    const mockRequire = (moduleName: string): unknown => {
      if (moduleName === '@sentry/react-native/metro') {
        return {
          getSentryExpoConfig: (_root: string, options?: Record<string, unknown>) => {
            sdkOptions = options;
            return { resolver: {}, transformerPath: join(mobileRoot, 'metro.config.js') };
          },
        };
      }
      if (moduleName === './metro-watchman.cjs') return { configureWatchman: () => {} };
      if (moduleName === './expo-web-response-headers.cjs') return { applyExpoWebResponseHeaders: () => {} };
      if (moduleName === './metro-web-runtime-resolution.cjs') return { resolveWebRuntimeModulePath };
      return require(moduleName);
    };
    mockRequire.resolve = (moduleName: string) =>
      require.resolve(moduleName.startsWith('.') ? join(mobileRoot, moduleName) : moduleName);
    runInNewContext(readFileSync(join(mobileRoot, 'metro.config.js'), 'utf8'), {
      __dirname: mobileRoot,
      process: { env: browserExport ? { BOARDSESH_WEB: '1' } : {} },
      module: metroModule,
      require: mockRequire,
    });
    return { config: metroModule.exports, sdkOptions };
  }
  const { config } = loadMetroConfig();

  function resolveCommonJs(platform: string, moduleName = 'react-native') {
    return config.resolver?.resolveRequest?.(
      {
        originModulePath: join(mobileRoot, 'node_modules/@sentry/react-native/dist/js/integrations/deeplink.js'),
        isESMImport: false,
        resolveRequest: (_context: unknown, requestedModule: string) => requestedModule,
      },
      moduleName,
      platform,
    );
  }

  it('redirects Sentry’s optional CommonJS native import to the isolated browser API', () => {
    expect(resolveCommonJs('web')).toBe(join(mobileRoot, 'web-runtime/node_modules/react-native-web'));
    expect(resolveCommonJs('web', 'react-native/package.json')).toBe('react-native/package.json');
  });

  it.each(['ios', 'android'])('keeps %s resolving the native API', (platform) => {
    expect(resolveCommonJs(platform)).toBe('react-native');
  });

  it('omits only unused browser replay/widgets while retaining native SDK defaults', () => {
    expect(loadMetroConfig(true).sdkOptions).toEqual({ includeWebReplay: false, includeWebFeedback: false });
    expect(loadMetroConfig(false).sdkOptions).toBeUndefined();
  });
});
