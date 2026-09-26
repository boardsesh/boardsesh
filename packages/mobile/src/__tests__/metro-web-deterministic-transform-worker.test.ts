import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// #5808: lightningcss returns a CSS module's class map in a per-process random
// order, which made two web exports of one commit differ. The web-only worker
// sorts it. These tests go through Expo's real CSS-module transform, so they
// fail if the hook stops reaching the call site Expo actually uses.
const require = createRequire(import.meta.url);
const mobileRoot = join(__dirname, '..', '..');
const workerModule = require('../../metro-web-deterministic-transform-worker.cjs') as {
  getCacheKey: (...args: unknown[]) => string;
  __test: { upstreamWorkerPath: string };
};
const cssModulesPath = join(dirname(workerModule.__test.upstreamWorkerPath), 'css-modules.js');
const { transformCssModuleWeb } = require(cssModulesPath) as {
  transformCssModuleWeb: (props: {
    filename: string;
    src: string;
    options: { projectRoot: string; dev: boolean; minify: boolean; sourceMap: boolean; reactServer: boolean };
  }) => Promise<{ output: string }>;
};

// Twelve classes: an unsorted HashMap lands in sorted order by chance about
// once in 479 million runs.
const classNames = [
  'zeta',
  'yak',
  'xray',
  'wolf',
  'violet',
  'umber',
  'tango',
  'sierra',
  'romeo',
  'quail',
  'papa',
  'oscar',
];
const cssModuleSource = classNames.map((className) => `.${className} { color: red; }`).join('\n');

function exportedKeyOrder(output: string): string[] {
  const styles = output.slice(output.indexOf('(') + 1, output.indexOf('},{unstable_styles') + 1);
  return Object.keys(JSON.parse(styles) as Record<string, string>);
}

function transformerPathFor(env: NodeJS.ProcessEnv): string {
  return execFileSync(process.execPath, ['-e', 'process.stdout.write(require("./metro.config.js").transformerPath)'], {
    cwd: mobileRoot,
    env,
    encoding: 'utf8',
  });
}

describe('metro-web-deterministic-transform-worker', () => {
  it('emits CSS-module class maps in sorted key order', async () => {
    const { output } = await transformCssModuleWeb({
      filename: 'determinism.module.css',
      src: cssModuleSource,
      options: { projectRoot: mobileRoot, dev: false, minify: true, sourceMap: false, reactServer: false },
    });
    expect(exportedKeyOrder(output)).toEqual([...classNames].sort());
  });

  it("wraps Expo's own default worker and keys the cache on it", () => {
    const expoMetroConfig = require(
      require.resolve('@expo/metro-config', { paths: [dirname(require.resolve('expo/package.json'))] }),
    ) as { unstable_transformerPath: string };
    expect(workerModule.__test.upstreamWorkerPath).toBe(expoMetroConfig.unstable_transformerPath);
    const { transformer } = require('../../metro.config.js') as { transformer: unknown };
    const upstreamWorker = require(workerModule.__test.upstreamWorkerPath) as typeof workerModule;
    const cacheKey = workerModule.getCacheKey(transformer, {});
    expect(cacheKey.startsWith(`${upstreamWorker.getCacheKey(transformer, {})}$`)).toBe(true);
    expect(cacheKey).toMatch(/\$[0-9a-f]{40}$/);
  });

  it('is only wired in for the web gate, so native keeps Expo’s worker', () => {
    const { BOARDSESH_WEB: _ignored, ...nativeEnv } = process.env;
    expect(transformerPathFor(nativeEnv)).toBe(workerModule.__test.upstreamWorkerPath);
    expect(transformerPathFor({ ...nativeEnv, BOARDSESH_WEB: '1' })).toBe(
      require.resolve('../../metro-web-deterministic-transform-worker.cjs'),
    );
  });
});
