import { describe, it, expect } from 'vitest';
import {
  androidBuildHidesScanResultsWithoutLocation,
  androidScanRequiresLocationServices,
  MANIFEST_HAS_NEVER_FOR_LOCATION,
  type AndroidScanLocationGateInput,
} from '../android-scan-location-gate';

describe('androidBuildHidesScanResultsWithoutLocation', () => {
  it('flags Android 12+ while the manifest still omits the disavowal', () => {
    expect(
      androidBuildHidesScanResultsWithoutLocation({
        platformOs: 'android',
        androidApiLevel: 31,
      }),
    ).toBe(true);
  });

  it('keeps flagging the newest Android API level', () => {
    // Upper-bound sanity: the gate reads the API level only for the Android 12
    // floor, so a future platform release must not change the answer.
    expect(
      androidBuildHidesScanResultsWithoutLocation({
        platformOs: 'android',
        androidApiLevel: 36,
      }),
    ).toBe(true);
  });

  it('stays off below Android 12, where the app already requests fine location', () => {
    expect(
      androidBuildHidesScanResultsWithoutLocation({
        platformOs: 'android',
        androidApiLevel: 30,
      }),
    ).toBe(false);
  });

  it('stays off on iOS', () => {
    expect(
      androidBuildHidesScanResultsWithoutLocation({
        platformOs: 'ios',
        androidApiLevel: 0,
      }),
    ).toBe(false);
  });

  it('pins the manifest flag to what the shipped manifest actually declares', () => {
    // READ THIS BEFORE FLIPPING THE CONSTANT TO MAKE THIS TEST PASS.
    //
    // No released or in-flight Android binary declares `BLUETOOTH_SCAN` with
    // `android:usesPermissionFlags="neverForLocation"`. The flag is native, so it
    // can only reach a NEW binary — but this constant is JS and rides an OTA
    // straight into every 2.2.x/2.3.x install that is still missing it. Flipping
    // it on its own therefore turns the hint off for exactly the users who need
    // it, and they go back to "make sure your board is powered on".
    //
    // The PR that adds the flag must gate on a versionCode floor as well
    // (expo-application's `nativeBuildVersion`), set to the first build that
    // contains it. An earlier revision of this module carried such a floor keyed
    // to the LAST build without the flag, which retired the hint on the very next
    // build number; the floor has to name a build that actually has the flag.
    expect(MANIFEST_HAS_NEVER_FOR_LOCATION).toBe(false);

    // The gate takes no build-number input today. Re-adding one is a type error
    // here until this exhaustive map is updated alongside it.
    const gateInputKeys: Record<keyof AndroidScanLocationGateInput, true> = {
      platformOs: true,
      androidApiLevel: true,
    };
    expect(Object.keys(gateInputKeys).sort()).toEqual(['androidApiLevel', 'platformOs']);
  });
});

describe('androidScanRequiresLocationServices', () => {
  it('flags Android 6 (API 23), the floor of the range', () => {
    expect(
      androidScanRequiresLocationServices({
        platformOs: 'android',
        androidApiLevel: 23,
      }),
    ).toBe(true);
  });

  it('flags Android 8 (API 26), mid-range', () => {
    expect(
      androidScanRequiresLocationServices({
        platformOs: 'android',
        androidApiLevel: 26,
      }),
    ).toBe(true);
  });

  it('flags Android 11 (API 30), the ceiling of the range', () => {
    expect(
      androidScanRequiresLocationServices({
        platformOs: 'android',
        androidApiLevel: 30,
      }),
    ).toBe(true);
  });

  it('stays off on Android 12 (API 31) — the permission-only gate takes over there', () => {
    expect(
      androidScanRequiresLocationServices({
        platformOs: 'android',
        androidApiLevel: 31,
      }),
    ).toBe(false);
  });

  it('stays off on a newer Android release', () => {
    expect(
      androidScanRequiresLocationServices({
        platformOs: 'android',
        androidApiLevel: 34,
      }),
    ).toBe(false);
  });

  it('stays off below Android 6', () => {
    expect(
      androidScanRequiresLocationServices({
        platformOs: 'android',
        androidApiLevel: 21,
      }),
    ).toBe(false);
  });

  it('stays off on iOS', () => {
    expect(
      androidScanRequiresLocationServices({
        platformOs: 'ios',
        androidApiLevel: 26,
      }),
    ).toBe(false);
  });

  it('is mutually exclusive with the permission gate at every API level', () => {
    for (let apiLevel = 21; apiLevel <= 36; apiLevel += 1) {
      const input: AndroidScanLocationGateInput = { platformOs: 'android', androidApiLevel: apiLevel };
      const needsServices = androidScanRequiresLocationServices(input);
      const needsPermissionOnly = androidBuildHidesScanResultsWithoutLocation(input);
      expect(needsServices && needsPermissionOnly).toBe(false);
    }
  });
});
