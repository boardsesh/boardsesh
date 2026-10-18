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
// WHY THE HINT IS RETIRED ON A VERSION CODE
// ------------------------------------------
// The flag is native: `plugins/with-android-bluetooth-feature.js` sets it on
// `BLUETOOTH_SCAN` (commit db21745fe7), so it reaches only a binary built after
// that commit. This module is JS and rides an OTA into every binary, old ones
// included. So the gate reads the running binary's Android `versionCode`
// (expo-application's `nativeBuildVersion`, read from the installed APK, which
// no OTA can move) and treats the flag as present only from the first build
// that carried it: 2000761 (`build-android-v2.3.0-2000761`, the first release
// tag that contains db21745fe7; 2000754 is the last that doesn't). Every older
// install keeps the hint it still needs.
//
// An earlier revision keyed a floor to the LAST build without the flag, which
// retired the hint for the very next build number, flag or not. The floor has
// to name a build that actually has it, and an unreadable build number reads as
// "no flag": a hint that turns out to be unnecessary costs a sentence, a missing
// one costs a climber an empty scan with the blame on their board.
//
// Two builds the floor misreads, in opposite directions:
// - Dev-client APKs (`com.boardsesh.app.dev`) take the workflow run number as
//   their versionCode (android-apk-dev-client.yml, "Set version code"), far
//   below the floor, so they read as "no flag" and keep the hint although they
//   carry the flag. That is the safe direction.
// - A native rebuild from a release anchor older than db21745fe7 would get a
//   new, higher versionCode without the flag and lose a hint it needs. That
//   can't happen today, because backports to an older fingerprint ship as OTAs
//   only, never as new binaries. A native backport path would have to change
//   this floor.
//
// (For the record, adding the flag is a one-line manifest edit, not a blocked
// one. `packages/mobile/app.config.ts` says ble-plx would cap
// ACCESS_FINE_LOCATION at `maxSdkVersion=30`; running `expo prebuild --platform
// android` both ways shows the cap is real but the flag is not — Expo's
// `android.permissions` mod declares `BLUETOOTH_SCAN` first and ble-plx's
// `addScanPermissionToManifest` early-returns on an existing element, so its
// prop is all cap and no flag. Setting the attribute ourselves gets the flag
// without the cap.)

/**
 * The first Android `versionCode` whose manifest declares `BLUETOOTH_SCAN` with
 * `android:usesPermissionFlags="neverForLocation"`.
 */
export const FIRST_ANDROID_BUILD_WITH_NEVER_FOR_LOCATION = 2_000_761;

/**
 * Whether the running Android binary's manifest carries `neverForLocation`,
 * from its `versionCode` as expo-application reports it (a string on Android).
 * False when the build number is missing or not a plain integer: the hint stays
 * for a binary we can't place.
 */
export function manifestHasNeverForLocation(nativeBuildVersion: string | null | undefined): boolean {
  if (!nativeBuildVersion || !/^\d+$/.test(nativeBuildVersion.trim())) return false;
  return Number(nativeBuildVersion.trim()) >= FIRST_ANDROID_BUILD_WITH_NEVER_FOR_LOCATION;
}

/** Android 12. Below this, BLE scanning genuinely requires location and the app already asks for it. */
const ANDROID_12_API_LEVEL = 31;

export type AndroidScanLocationGateInput = {
  /** `Platform.OS`. */
  platformOs: string;
  /** `Platform.Version` on Android, i.e. the API level. */
  androidApiLevel: number;
  /**
   * expo-application's `nativeBuildVersion`: the installed binary's Android
   * `versionCode`, null when unknown. Only `androidBuildHidesScanResultsWithoutLocation`
   * reads it.
   */
  nativeBuildVersion: string | null;
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
  nativeBuildVersion,
}: AndroidScanLocationGateInput): boolean {
  if (platformOs !== 'android') return false;
  if (androidApiLevel < ANDROID_12_API_LEVEL) return false;

  return !manifestHasNeverForLocation(nativeBuildVersion);
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
