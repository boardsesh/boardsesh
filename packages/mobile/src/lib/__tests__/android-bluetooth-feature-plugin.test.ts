import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type UsesFeature = {
  $: Record<string, string>;
};

type AndroidManifestShape = {
  manifest: {
    $?: Record<string, string>;
    'uses-feature'?: UsesFeature[];
    'uses-permission'?: UsesFeature[];
    'uses-permission-sdk-23'?: UsesFeature[];
  };
};

type BluetoothFeaturePlugin = {
  addBluetoothLeFeature(androidManifest: AndroidManifestShape): AndroidManifestShape;
  addNeverForLocationScanFlag(androidManifest: AndroidManifestShape): AndroidManifestShape;
  FEATURE_NAME: string;
  SCAN_PERMISSION_NAME: string;
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

/** What Expo's base `android.permissions` mod leaves behind before our mod runs. */
function manifestWithBaseScanPermission(): AndroidManifestShape {
  return {
    manifest: {
      $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
      'uses-permission': [{ $: { 'android:name': plugin.SCAN_PERMISSION_NAME } }],
    },
  };
}

function scanPermissionOf(result: AndroidManifestShape): UsesFeature | undefined {
  return (result.manifest['uses-permission'] ?? []).find(
    (permission) => permission.$['android:name'] === plugin.SCAN_PERMISSION_NAME,
  );
}

describe('addNeverForLocationScanFlag', () => {
  it('flags an existing BLUETOOTH_SCAN as neverForLocation', () => {
    // The bug this whole change exists for: without the flag, Android 12+ drops
    // every scan result for a caller that has no location permission — no error,
    // no callback, just an empty board picker.
    const result = plugin.addNeverForLocationScanFlag(manifestWithBaseScanPermission());
    const scanPermission = scanPermissionOf(result);

    expect(scanPermission?.$['android:usesPermissionFlags']).toBe('neverForLocation');
    expect(scanPermission?.$['tools:targetApi']).toBe('31');
  });

  it('does not cap or otherwise modify location permissions', () => {
    // The highest-consequence wrong fix is "simplify" this to ble-plx's
    // `neverForLocation: true` prop, which caps ACCESS_COARSE/FINE_LOCATION at
    // maxSdkVersion=30 and silently breaks nearby-boards + Google Maps on
    // Android 12+. Nothing here may touch a location declaration.
    const manifest: AndroidManifestShape = {
      manifest: {
        $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
        'uses-permission': [
          { $: { 'android:name': plugin.SCAN_PERMISSION_NAME } },
          { $: { 'android:name': 'android.permission.ACCESS_FINE_LOCATION' } },
          { $: { 'android:name': 'android.permission.ACCESS_COARSE_LOCATION' } },
        ],
        'uses-permission-sdk-23': [{ $: { 'android:name': 'android.permission.ACCESS_FINE_LOCATION' } }],
      },
    };

    const result = plugin.addNeverForLocationScanFlag(manifest);
    const locationEntries = [
      ...(result.manifest['uses-permission'] ?? []),
      ...(result.manifest['uses-permission-sdk-23'] ?? []),
    ].filter((permission) => permission.$['android:name'].includes('_LOCATION'));

    expect(locationEntries).toHaveLength(3);
    for (const entry of locationEntries) {
      expect(entry.$['android:maxSdkVersion']).toBeUndefined();
      expect(entry.$['android:usesPermissionFlags']).toBeUndefined();
    }
  });

  it('adds a flagged BLUETOOTH_SCAN when none is declared', () => {
    // Find-or-create: a mod-ordering or `android.permissions` change that stops
    // Expo's base mod from declaring BLUETOOTH_SCAN first would otherwise turn
    // this whole fix into a silent no-op.
    const result = plugin.addNeverForLocationScanFlag({
      manifest: { $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' } },
    });
    const scanPermission = scanPermissionOf(result);

    expect(scanPermission?.$['android:usesPermissionFlags']).toBe('neverForLocation');
    expect(result.manifest['uses-permission']).toHaveLength(1);
  });

  it('is idempotent — a second pass leaves one flagged entry', () => {
    const once = plugin.addNeverForLocationScanFlag(manifestWithBaseScanPermission());
    const twice = plugin.addNeverForLocationScanFlag(once);

    const scanEntries = (twice.manifest['uses-permission'] ?? []).filter(
      (permission) => permission.$['android:name'] === plugin.SCAN_PERMISSION_NAME,
    );
    expect(scanEntries).toHaveLength(1);
    expect(scanEntries[0]?.$['android:usesPermissionFlags']).toBe('neverForLocation');
  });

  it('ensures the tools namespace so tools:targetApi is legal', () => {
    // Emitting a tools: attribute into a manifest with no tools namespace fails
    // the Android build. It happens to be present today only because of the
    // unrelated BLUETOOTH_ADVERTISE `tools:node="remove"` block.
    const result = plugin.addNeverForLocationScanFlag(manifestWithBaseScanPermission());

    expect(result.manifest.$?.['xmlns:tools']).toBe('http://schemas.android.com/tools');
  });
});

describe('the two mods composed, as withAndroidBluetoothFeature runs them', () => {
  it('keeps both results when chained through the same manifest object', () => {
    // withAndroidBluetoothFeature assigns each mod's return value back onto
    // modConfig.modResults, so the second mod's return has to still carry the
    // first mod's mutations. AndroidConfig.Manifest.ensureToolsAvailable mutates
    // in place today; if it ever started returning a fresh object, the
    // uses-feature entry would silently vanish from the generated manifest.
    const chained = plugin.addNeverForLocationScanFlag(plugin.addBluetoothLeFeature(manifestWithBaseScanPermission()));

    const bleFeature = (chained.manifest['uses-feature'] ?? []).find(
      (feature) => feature.$['android:name'] === plugin.FEATURE_NAME,
    );
    expect(bleFeature?.$['android:required']).toBe('false');
    expect(scanPermissionOf(chained)?.$['android:usesPermissionFlags']).toBe('neverForLocation');
    expect(chained.manifest.$?.['xmlns:tools']).toBe('http://schemas.android.com/tools');
  });

  it('is order-independent', () => {
    const otherOrder = plugin.addBluetoothLeFeature(
      plugin.addNeverForLocationScanFlag(manifestWithBaseScanPermission()),
    );

    expect(otherOrder.manifest['uses-feature']).toHaveLength(1);
    expect(scanPermissionOf(otherOrder)?.$['android:usesPermissionFlags']).toBe('neverForLocation');
  });
});
