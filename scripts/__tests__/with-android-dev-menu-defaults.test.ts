/// <reference types="node" />
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

// The plugin reads env loosely (only `env.BOARDSESH_METRO_PORT`, defaulting to
// process.env), so model the param as a bare env-like record — same reason as
// with-screenshot-dev-menu.test.ts.
type EnvLike = Record<string, string | undefined>;
type MetaDataItem = { $: Record<string, string> };
type AndroidManifest = {
  manifest: { application: Array<{ $: Record<string, string>; 'meta-data'?: MetaDataItem[] }> };
};
type AndroidDevMenuPlugin = {
  applyAndroidDevMenuDefaults: (androidManifest: AndroidManifest, env?: EnvLike) => AndroidManifest;
  LAUNCHER_URL_KEY: string;
};

const plugin = require('../../packages/mobile/plugins/with-android-dev-menu-defaults.js') as AndroidDevMenuPlugin;

function makeManifest(): AndroidManifest {
  return { manifest: { application: [{ $: { 'android:name': '.MainApplication' }, 'meta-data': [] }] } };
}

function metaData(manifest: AndroidManifest): Record<string, string> {
  const items = manifest.manifest.application[0]['meta-data'] ?? [];
  return Object.fromEntries(items.map((item) => [item.$['android:name'], item.$['android:value']]));
}

describe('with-android-dev-menu-defaults', () => {
  it('bakes the launcher URL and the three dev-menu suppressions into <application>', () => {
    const manifest = plugin.applyAndroidDevMenuDefaults(makeManifest(), {});

    expect(metaData(manifest)).toEqual({
      DEV_CLIENT_DEFAULT_LAUNCHER_URL: 'http://localhost:8081',
      // Manifest meta-data carries strings, not booleans.
      EXDevMenuIsOnboardingFinished: 'true',
      EXDevMenuShowFloatingActionButton: 'false',
      EXDevMenuShowsAtLaunch: 'false',
    });
  });

  it('honours BOARDSESH_METRO_PORT for the baked launcher URL', () => {
    const manifest = plugin.applyAndroidDevMenuDefaults(makeManifest(), { BOARDSESH_METRO_PORT: '8091' });

    expect(metaData(manifest)[plugin.LAUNCHER_URL_KEY]).toBe('http://localhost:8091');
  });

  it('is idempotent: a second apply replaces rather than duplicates the items', () => {
    const manifest = plugin.applyAndroidDevMenuDefaults(makeManifest(), {});
    plugin.applyAndroidDevMenuDefaults(manifest, { BOARDSESH_METRO_PORT: '8091' });

    const items = manifest.manifest.application[0]['meta-data'] ?? [];
    expect(items).toHaveLength(4);
    expect(items.map((item) => item.$['android:name']).sort()).toEqual([
      'DEV_CLIENT_DEFAULT_LAUNCHER_URL',
      'EXDevMenuIsOnboardingFinished',
      'EXDevMenuShowFloatingActionButton',
      'EXDevMenuShowsAtLaunch',
    ]);
    expect(metaData(manifest)[plugin.LAUNCHER_URL_KEY]).toBe('http://localhost:8091');
  });
});

describe('app.config.ts registration', () => {
  // Source-level assertion rather than resolving the config: app.config.ts pulls
  // in the whole mobile config graph (expo-updates, board constants, Sentry
  // config), which the `scripts` vitest project has no module resolution for.
  // The line is what has to stay dev-variant-gated — registering the plugin
  // unconditionally would move the production native fingerprint.
  const appConfigSource = readFileSync(join(__dirname, '..', '..', 'packages', 'mobile', 'app.config.ts'), 'utf8');

  it('registers the plugin only for the dev variant', () => {
    expect(appConfigSource).toContain("...(isDevVariant ? ['./plugins/with-android-dev-menu-defaults'] : [])");
    // No second, ungated registration.
    expect(appConfigSource.split('./plugins/with-android-dev-menu-defaults')).toHaveLength(2);
  });

  it('still derives isDevVariant from BOARDSESH_APP_VARIANT', () => {
    expect(appConfigSource).toContain("const isDevVariant = process.env.BOARDSESH_APP_VARIANT === 'dev'");
  });
});
