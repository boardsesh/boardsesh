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
const wrapperPath = require.resolve('../../metro-web-deterministic-transform-worker.cjs');

// Production order: Expo's supervising worker loads its own transform worker
// (and css-modules.js with it) before it requires ours. Load them in that
// order here too, so a module-scope lightningcss read in css-modules.js would
// escape the hook and turn this test red.
const expoWorkerPath = require.resolve('@expo/metro-config/build/transform-worker/transform-worker', {
  paths: [dirname(require.resolve('expo/package.json'))],
});
require(expoWorkerPath);
const { transformCssModuleWeb } = require(join(dirname(expoWorkerPath), 'css-modules.js')) as {
  transformCssModuleWeb: (props: {
    filename: string;
    src: string;
    options: { projectRoot: string; dev: boolean; minify: boolean; sourceMap: boolean; reactServer: boolean };
  }) => Promise<{ output: string }>;
};
const workerModule = require(wrapperPath) as { __test: { upstreamWorkerPath: string } };

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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exportedKeyOrder(output: string): string[] {
  const stylesStart = output.indexOf('Object.assign(');
  const stylesEnd = output.indexOf('},{unstable_styles');
  if (stylesStart === -1 || stylesEnd === -1) {
    throw new Error(`Expo's CSS-module output changed shape; cannot find the class map in: ${output.slice(0, 200)}`);
  }
  const styles = output.slice(stylesStart + 'Object.assign('.length, stylesEnd + 1);
  return Object.keys(JSON.parse(styles) as Record<string, string>);
}

function metroConfigFor(env: NodeJS.ProcessEnv): { transformerPath: string; cacheVersion: string } {
  const script =
    'const c=require("./metro.config.js");process.stdout.write(JSON.stringify([c.transformerPath,c.cacheVersion]))';
  const [transformerPath, cacheVersion] = JSON.parse(
    execFileSync(process.execPath, ['-e', script], { cwd: mobileRoot, env, encoding: 'utf8' }),
  ) as [string, string];
  return { transformerPath, cacheVersion };
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

  it("wraps Expo's own default worker", () => {
    expect(workerModule.__test.upstreamWorkerPath).toBe(expoWorkerPath);
  });

  it('is only wired in for the web gate, where it also salts the cache key', () => {
    const { BOARDSESH_WEB: _ignored, ...nativeEnv } = process.env;
    const native = metroConfigFor(nativeEnv);
    const web = metroConfigFor({ ...nativeEnv, BOARDSESH_WEB: '1' });
    expect(native.transformerPath).toBe(expoWorkerPath);
    expect(web.transformerPath).toBe(wrapperPath);
    // Expo CLI's supervising worker keys neither our file nor a getCacheKey we
    // export; Metro's getTransformCacheKey does include cacheVersion.
    expect(web.cacheVersion).toMatch(new RegExp(`^${escapeRegExp(native.cacheVersion)}\\+web-[0-9a-f]{16}$`));
  });
});
