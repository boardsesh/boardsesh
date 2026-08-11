// Why a zero-result BLE scan on Android 12+ is often a *permission* problem.
//
// On API 31+ the platform treats every BLE scan as potentially location-deriving
// unless the app's `BLUETOOTH_SCAN` declaration carries
// `android:usesPermissionFlags="neverForLocation"`. Without that flag, AOSP's
// scan path gates each delivered ScanResult on the caller holding
// ACCESS_FINE_LOCATION or ACCESS_COARSE_LOCATION — and drops the results in the
// delivery loop rather than rejecting `startScan()`. The app sees a scan that
// starts fine, reports no error, and finds nothing.
//
// Boardsesh's runtime request on API 31+ asks only for BLUETOOTH_SCAN /
// BLUETOOTH_CONNECT (correct, and what we want long term), so a user who
// declined the separate "find boards near you" location prompt gets a
// permanently empty board picker with troubleshooting copy blaming their board.
// This module decides when to swap the misleading hardware troubleshooting for
// an honest "Android is hiding the scan results until Location is allowed" hint
// plus a grant button.
//
// WHY THE HINT IS NOT RETIRED ON A VERSION CODE (YET)
// ---------------------------------------------------
// The tempting design is to compare the running binary's Android `versionCode`
// against the last release that shipped without the flag, so the hint falls away
// once a fixed build goes out. There is nothing to compare against: no shipped
// or in-flight binary carries `neverForLocation`, so the floor would have to be
// "the first build that has it" — a number that does not exist until the
// manifest change actually ships. Keying off the last build we know about
// instead retires the hint for the *next* build number, i.e. for a binary that
// still needs it.
//
// (For the record, adding the flag is a one-line manifest edit, not a blocked
// one. `packages/mobile/app.config.ts` says ble-plx would cap
// ACCESS_FINE_LOCATION at `maxSdkVersion=30`; running `expo prebuild --platform
// android` both ways shows the cap is real but the flag is not — Expo's
// `android.permissions` mod declares `BLUETOOTH_SCAN` first and ble-plx's
// `addScanPermissionToManifest` early-returns on an existing element, so its
// prop is all cap and no flag. Setting the attribute ourselves gets the flag
// without the cap.)
//
// So the gate is an explicit constant that the PR adding the flag has to flip.
// That flag is a native change reaching only new binaries, while this JS
// constant reaches OLD binaries over the air — so the PR that flips it must
// also gate on a `versionCode` floor (expo-application's `nativeBuildVersion`)
// set to the first build that contains the flag, or every 2.2.x/2.3.x install
// loses a hint it still needs.

/**
 * Whether the shipped Android manifest declares `BLUETOOTH_SCAN` with
 * `android:usesPermissionFlags="neverForLocation"`.
 *
 * False: no released or in-flight binary carries the flag yet. Flip this only
 * in the PR that actually adds it to the manifest, and read the note above
 * about old binaries first — flipping it alone strands them.
 */
export const MANIFEST_HAS_NEVER_FOR_LOCATION = false;

/** Android 12. Below this, BLE scanning genuinely requires location and the app already asks for it. */
const ANDROID_12_API_LEVEL = 31;

export type AndroidScanLocationGateInput = {
  /** `Platform.OS`. */
  platformOs: string;
  /** `Platform.Version` on Android, i.e. the API level. */
  androidApiLevel: number;
};

/**
 * True when the running binary's manifest still lets Android suppress scan
 * results for a caller without location permission — i.e. when granting
 * location is a real remedy for an empty scan.
 *
 * Returns false off Android and below Android 12 (the app already requests fine
 * location there, and a denial surfaces as an explicit failure rather than an
 * empty list).
 */
export function androidBuildHidesScanResultsWithoutLocation({
  platformOs,
  androidApiLevel,
}: AndroidScanLocationGateInput): boolean {
  if (platformOs !== 'android') return false;
  if (androidApiLevel < ANDROID_12_API_LEVEL) return false;

  return !MANIFEST_HAS_NEVER_FOR_LOCATION;
}

/** Android 6 (API 23). Below this, BLE scanning did not require location at all. */
const ANDROID_6_API_LEVEL = 23;

/**
 * True when the running binary is on the Android range (6 through 11, API
 * 23-30) where BLE scan-result delivery is gated on the system-wide Location
 * *services* toggle, not just the app's location *permission*. AOSP suppresses
 * every ScanResult while Location is switched off, even with
 * ACCESS_FINE_LOCATION granted — the scan starts cleanly, reports no error, and
 * finds nothing.
 *
 * From Android 12 (API 31) onward the services toggle is no longer required —
 * only the permission is (see `androidBuildHidesScanResultsWithoutLocation`
 * above) — so this and that predicate are mutually exclusive by construction.
 */
export function androidScanRequiresLocationServices({
  platformOs,
  androidApiLevel,
}: AndroidScanLocationGateInput): boolean {
  if (platformOs !== 'android') return false;
  return androidApiLevel >= ANDROID_6_API_LEVEL && androidApiLevel < ANDROID_12_API_LEVEL;
}
