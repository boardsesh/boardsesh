import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type UsesFeature = {
  $: Record<string, string>;
};

type AndroidManifestShape = {
  manifest: {
    'uses-feature'?: UsesFeature[];
    'uses-permission'?: UsesFeature[];
  };
};

type BluetoothFeaturePlugin = {
  addBluetoothLeFeature(androidManifest: AndroidManifestShape): AndroidManifestShape;
  FEATURE_NAME: string;
};

const plugin = require('../../../plugins/with-android-bluetooth-feature.js') as BluetoothFeaturePlugin;

function emptyManifest(): AndroidManifestShape {
  return { manifest: {} };
}

describe('with-android-bluetooth-feature', () => {
  it('adds a non-required bluetooth_le uses-feature', () => {
    const result = plugin.addBluetoothLeFeature(emptyManifest());

    const features = result.manifest['uses-feature'] ?? [];
    const ble = features.find((feature) => feature.$['android:name'] === plugin.FEATURE_NAME);

    expect(ble).toBeDefined();
    expect(ble?.$['android:required']).toBe('false');
  });

  it('preserves existing uses-feature entries', () => {
    const manifest: AndroidManifestShape = {
      manifest: { 'uses-feature': [{ $: { 'android:name': 'android.hardware.camera', 'android:required': 'false' } }] },
    };

    const result = plugin.addBluetoothLeFeature(manifest);
    const names = (result.manifest['uses-feature'] ?? []).map((feature) => feature.$['android:name']);

    expect(names).toContain('android.hardware.camera');
    expect(names).toContain(plugin.FEATURE_NAME);
  });

  it('is idempotent — a second pass adds no duplicate', () => {
    const once = plugin.addBluetoothLeFeature(emptyManifest());
    const twice = plugin.addBluetoothLeFeature(once);

    const bleEntries = (twice.manifest['uses-feature'] ?? []).filter(
      (feature) => feature.$['android:name'] === plugin.FEATURE_NAME,
    );
    expect(bleEntries).toHaveLength(1);
  });
});
