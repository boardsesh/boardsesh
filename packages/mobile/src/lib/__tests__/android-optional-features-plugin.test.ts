import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type AndroidManifestShape = {
  manifest: {
    'uses-feature'?: Array<{ $: Record<string, string> }>;
    'uses-permission'?: Array<{ $: Record<string, string> }>;
    application?: Array<{ activity?: Array<{ $: Record<string, string> }> }>;
  };
};

type OptionalFeaturesPlugin = {
  addOptionalFeatures(androidManifest: AndroidManifestShape): AndroidManifestShape;
};

const plugin = require('../../../plugins/with-android-optional-features.js') as OptionalFeaturesPlugin;

describe('with-android-optional-features', () => {
  it('explicitly makes portrait displays and Wi-Fi hardware optional', () => {
    const result = plugin.addOptionalFeatures({ manifest: {} });

    expect(result.manifest['uses-feature']).toEqual([
      { $: { 'android:name': 'android.hardware.screen.portrait', 'android:required': 'false' } },
      { $: { 'android:name': 'android.hardware.wifi', 'android:required': 'false' } },
    ]);
  });

  it('overrides explicit and default requirements while preserving other attributes', () => {
    const result = plugin.addOptionalFeatures({
      manifest: {
        'uses-feature': [
          { $: { 'android:name': 'android.hardware.screen.portrait', 'android:required': 'true' } },
          { $: { 'android:name': 'android.hardware.wifi', 'android:version': '1' } },
          { $: { 'android:name': 'android.hardware.camera', 'android:required': 'true' } },
        ],
      },
    });

    expect(result.manifest['uses-feature']).toEqual([
      { $: { 'android:name': 'android.hardware.screen.portrait', 'android:required': 'false' } },
      { $: { 'android:name': 'android.hardware.wifi', 'android:version': '1', 'android:required': 'false' } },
      { $: { 'android:name': 'android.hardware.camera', 'android:required': 'true' } },
    ]);
  });

  it('preserves Wi-Fi permissions and the activity orientation', () => {
    const manifest: AndroidManifestShape = {
      manifest: {
        'uses-permission': [{ $: { 'android:name': 'android.permission.ACCESS_WIFI_STATE' } }],
        application: [
          { activity: [{ $: { 'android:name': '.MainActivity', 'android:screenOrientation': 'portrait' } }] },
        ],
      },
    };
    const original = structuredClone(manifest);

    const result = plugin.addOptionalFeatures(manifest);

    expect(result.manifest['uses-permission']).toEqual(original.manifest['uses-permission']);
    expect(result.manifest.application).toEqual(original.manifest.application);
  });

  it('leaves the manifest unchanged on a second pass', () => {
    const once = plugin.addOptionalFeatures({ manifest: {} });
    const twice = plugin.addOptionalFeatures(structuredClone(once));

    expect(twice).toEqual(once);
  });

  it('is registered in the app config', () => {
    const appConfig = readFileSync(fileURLToPath(new URL('../../../app.config.ts', import.meta.url)), 'utf8');

    expect(appConfig).toContain("'./plugins/with-android-optional-features'");
  });
});
