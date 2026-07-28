const { AndroidConfig, createRunOncePlugin, withAndroidManifest } = require('expo/config-plugins');

// Owns both of the app's Android Bluetooth manifest bits:
//   1. the `<uses-feature android:name="android.hardware.bluetooth_le">` declaration, and
//   2. the `neverForLocation` disavowal on `<uses-permission BLUETOOTH_SCAN>`.
// Neither is expressible through `app.config.ts`'s `android.permissions` list,
// and neither belongs to a dependency's plugin (see the BLUETOOTH_SCAN note
// below for why react-native-ble-plx's `neverForLocation` prop is not usable).

// Declares BLE as a *recommended* (not required) hardware feature. Play uses
// <uses-feature> for store filtering and device-catalogue ranking. We use
// required="false" on purpose: the app is fully usable without a board (browse
// climbs, manage the queue, view the logbook), so required="true" would
// needlessly hide the listing from BLE-less devices and emulators and drag down
// the Play pre-launch report. The boolean lives in an attribute so the marker
// is the feature name itself — re-running prebuild finds it and no-ops.
const FEATURE_NAME = 'android.hardware.bluetooth_le';

const SCAN_PERMISSION_NAME = 'android.permission.BLUETOOTH_SCAN';

/**
 * Adds `<uses-feature android:name="android.hardware.bluetooth_le"
 * android:required="false" />` to the parsed AndroidManifest. Idempotent: a
 * second pass (or a double-registered plugin) leaves the manifest unchanged.
 * Pure transform over the @expo/config-plugins manifest object for testability.
 *
 * @param {{ manifest: { 'uses-feature'?: Array<{ $: Record<string, string> }> } }} androidManifest
 * @returns {typeof androidManifest}
 */
function addBluetoothLeFeature(androidManifest) {
  const manifest = androidManifest.manifest;
  const usesFeature = manifest['uses-feature'] ?? [];

  const alreadyDeclared = usesFeature.some((feature) => feature?.$?.['android:name'] === FEATURE_NAME);
  if (alreadyDeclared) {
    return androidManifest;
  }

  usesFeature.push({
    $: {
      'android:name': FEATURE_NAME,
      'android:required': 'false',
    },
  });
  manifest['uses-feature'] = usesFeature;

  return androidManifest;
}

/**
 * Marks `BLUETOOTH_SCAN` with `android:usesPermissionFlags="neverForLocation"`.
 *
 * Without it, Android 12+ (API 31) treats every BLE scan as potentially
 * location-deriving: AOSP's `Utils.hasDisavowedLocationForScan()` reads this
 * exact flag off the calling package's `BLUETOOTH_SCAN` declaration, and when
 * it is absent each delivered `ScanResult` is gated on the caller holding
 * ACCESS_FINE/COARSE_LOCATION. Results are dropped in the *delivery* loop, not
 * rejected at `startScan()` — so the app sees a scan that starts cleanly,
 * reports no error, and finds nothing. Boardsesh's runtime request asks only
 * for BLUETOOTH_SCAN/BLUETOOTH_CONNECT on API 31+, so anyone who declined the
 * separate "boards near you" location prompt got a permanently empty picker.
 *
 * Why this mod and not react-native-ble-plx's `neverForLocation: true` prop:
 * verified by running `expo prebuild --platform android` both ways. The prop
 * caps ACCESS_COARSE/FINE_LOCATION at `maxSdkVersion=30` (which would break
 * expo-location's nearby-boards and expo-maps on Android 12+) and leaves
 * BLUETOOTH_SCAN *completely untouched*, because Expo's base `android.permissions`
 * mod declares BLUETOOTH_SCAN first and ble-plx's `addScanPermissionToManifest`
 * early-returns on an existing element. All of the cost, none of the benefit.
 *
 * Find-or-create rather than find-only: if a future mod-ordering change stops
 * Expo's base mod from declaring BLUETOOTH_SCAN before this one, the fix
 * degrades to "still correct" instead of silently reverting. Location
 * permissions are never touched here — they stay uncapped on purpose.
 *
 * @param {{ manifest: { $?: Record<string, string>, 'uses-permission'?: Array<{ $: Record<string, string> }> } }} androidManifest
 * @returns {typeof androidManifest}
 */
function addNeverForLocationScanFlag(androidManifest) {
  // `tools:targetApi` needs the tools namespace on <manifest>. It happens to be
  // present today (the BLUETOOTH_ADVERTISE `tools:node="remove"` block puts it
  // there), but emitting a tools: attribute without it fails the Android build,
  // so don't depend on an unrelated block staying put.
  const withTools = AndroidConfig.Manifest.ensureToolsAvailable(androidManifest);
  const manifest = withTools.manifest;
  const usesPermission = manifest['uses-permission'] ?? [];

  let scanPermission = usesPermission.find((permission) => permission?.$?.['android:name'] === SCAN_PERMISSION_NAME);
  if (!scanPermission) {
    scanPermission = { $: { 'android:name': SCAN_PERMISSION_NAME } };
    usesPermission.push(scanPermission);
    manifest['uses-permission'] = usesPermission;
  }

  scanPermission.$['android:usesPermissionFlags'] = 'neverForLocation';
  scanPermission.$['tools:targetApi'] = '31';

  return withTools;
}

function withAndroidBluetoothFeature(config) {
  return withAndroidManifest(config, (modConfig) => {
    modConfig.modResults = addBluetoothLeFeature(modConfig.modResults);
    modConfig.modResults = addNeverForLocationScanFlag(modConfig.modResults);
    return modConfig;
  });
}

module.exports = createRunOncePlugin(withAndroidBluetoothFeature, 'with-android-bluetooth-feature', '1.1.0');
module.exports.addBluetoothLeFeature = addBluetoothLeFeature;
module.exports.addNeverForLocationScanFlag = addNeverForLocationScanFlag;
module.exports.FEATURE_NAME = FEATURE_NAME;
module.exports.SCAN_PERMISSION_NAME = SCAN_PERMISSION_NAME;
