import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type AndroidManifestShape = {
  manifest: {
    application?: Array<{ $?: Record<string, string> }>;
  };
};

type LanHttpPlugin = {
  applyNetworkSecurityConfig(androidManifest: AndroidManifestShape): AndroidManifestShape;
  NETWORK_SECURITY_CONFIG_NAME: string;
  NETWORK_SECURITY_CONFIG_XML: string;
};

const plugin = require('../../../plugins/with-android-lan-http.js') as LanHttpPlugin;

describe('with-android-lan-http', () => {
  it('points the application at the network security config and keeps its attributes', () => {
    const result = plugin.applyNetworkSecurityConfig({
      manifest: { application: [{ $: { 'android:name': '.MainApplication' } }] },
    });

    expect(result.manifest.application?.[0].$).toEqual({
      'android:name': '.MainApplication',
      'android:networkSecurityConfig': `@xml/${plugin.NETWORK_SECURITY_CONFIG_NAME}`,
    });
  });

  it('leaves the manifest unchanged on a second pass', () => {
    const once = plugin.applyNetworkSecurityConfig({ manifest: { application: [{}] } });
    const twice = plugin.applyNetworkSecurityConfig(structuredClone(once));

    expect(twice).toEqual(once);
  });

  it('fails the prebuild when the manifest has no application', () => {
    expect(() => plugin.applyNetworkSecurityConfig({ manifest: {} })).toThrow('no <application>');
  });

  it('permits LAN HTTP but keeps every Boardsesh host on HTTPS', () => {
    expect(plugin.NETWORK_SECURITY_CONFIG_XML).toContain('<base-config cleartextTrafficPermitted="true" />');
    expect(plugin.NETWORK_SECURITY_CONFIG_XML).toMatch(
      /<domain-config cleartextTrafficPermitted="false">\s*<domain includeSubdomains="true">boardsesh\.com<\/domain>/,
    );
  });

  it('targets an SDK where LAN access needs no runtime permission', () => {
    const reactNativeRoot = dirname(require.resolve('react-native/package.json'));
    const versions = readFileSync(join(reactNativeRoot, 'gradle', 'libs.versions.toml'), 'utf8');
    const targetSdk = Number(/^targetSdk = "(\d+)"/m.exec(versions)?.[1]);

    expect(
      targetSdk,
      'At target SDK 37 WLED needs ACCESS_LOCAL_NETWORK, requested when the climber connects. See docs/spray-wall-led.md.',
    ).toBeLessThan(37);
  });

  it('is registered in the app config', () => {
    const appConfig = readFileSync(fileURLToPath(new URL('../../../app.config.ts', import.meta.url)), 'utf8');

    expect(appConfig).toContain("'./plugins/with-android-lan-http'");
  });
});
