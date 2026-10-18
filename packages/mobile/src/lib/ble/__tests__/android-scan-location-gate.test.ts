import { describe, it, expect } from 'vitest';
import {
  androidBuildHidesScanResultsWithoutLocation,
  androidScanRequiresLocationServices,
  FIRST_ANDROID_BUILD_WITH_NEVER_FOR_LOCATION,
  manifestHasNeverForLocation,
  type AndroidScanLocationGateInput,
} from '../android-scan-location-gate';

// The last Android build without `neverForLocation` and the first with it, by
// release tag: build-android-v2.3.0-2000754 does not contain db21745fe7,
// build-android-v2.3.0-2000761 does.
const LAST_BUILD_WITHOUT_FLAG = '2000754';
const FIRST_BUILD_WITH_FLAG = '2000761';

describe('manifestHasNeverForLocation', () => {
  it('names the first build that shipped the flag', () => {
    expect(FIRST_ANDROID_BUILD_WITH_NEVER_FOR_LOCATION).toBe(Number(FIRST_BUILD_WITH_FLAG));
  });

  it('is true from the first build with the flag onward', () => {
    expect(manifestHasNeverForLocation(FIRST_BUILD_WITH_FLAG)).toBe(true);
    expect(manifestHasNeverForLocation('2001310')).toBe(true);
  });

  // The floor names a build that HAS the flag. An earlier revision keyed it to
  // the last build without it, which retired the hint one build early.
  it('is false for the build just below the floor', () => {
    expect(manifestHasNeverForLocation(String(FIRST_ANDROID_BUILD_WITH_NEVER_FOR_LOCATION - 1))).toBe(false);
    expect(manifestHasNeverForLocation(LAST_BUILD_WITHOUT_FLAG)).toBe(false);
  });

  // A binary we can't place keeps the hint: an unneeded hint costs a sentence,
  // a missing one an empty scan blamed on the board.
  it.each([null, undefined, '', '   ', 'abc', '2000761.1', '-2000761', '2.3.0'])(
    'is false for an unreadable build number (%s)',
    (nativeBuildVersion) => {
      expect(manifestHasNeverForLocation(nativeBuildVersion)).toBe(false);
    },
  );
});

describe('androidBuildHidesScanResultsWithoutLocation', () => {
  it('flags Android 12+ on a binary built before the flag', () => {
    expect(
      androidBuildHidesScanResultsWithoutLocation({
        platformOs: 'android',
        androidApiLevel: 31,
        nativeBuildVersion: LAST_BUILD_WITHOUT_FLAG,
      }),
    ).toBe(true);
  });

  it('stops flagging Android 12+ from the first binary with the flag', () => {
    expect(
      androidBuildHidesScanResultsWithoutLocation({
        platformOs: 'android',
        androidApiLevel: 31,
        nativeBuildVersion: FIRST_BUILD_WITH_FLAG,
      }),
    ).toBe(false);
  });

  it('keeps flagging when the build number is unknown', () => {
    expect(
      androidBuildHidesScanResultsWithoutLocation({
        platformOs: 'android',
        androidApiLevel: 34,
        nativeBuildVersion: null,
      }),
    ).toBe(true);
  });

  it('keeps flagging the newest Android API level on an old binary', () => {
    // Upper-bound sanity: the gate reads the API level only for the Android 12
    // floor, so a future platform release must not change the answer.
    expect(
      androidBuildHidesScanResultsWithoutLocation({
        platformOs: 'android',
        androidApiLevel: 36,
        nativeBuildVersion: LAST_BUILD_WITHOUT_FLAG,
      }),
    ).toBe(true);
  });

  it('stays off below Android 12, where the app already requests fine location', () => {
    expect(
      androidBuildHidesScanResultsWithoutLocation({
        platformOs: 'android',
        androidApiLevel: 30,
        nativeBuildVersion: LAST_BUILD_WITHOUT_FLAG,
      }),
    ).toBe(false);
  });

  it('stays off on iOS, whatever the build number', () => {
    expect(
      androidBuildHidesScanResultsWithoutLocation({
        platformOs: 'ios',
        androidApiLevel: 0,
        nativeBuildVersion: '1',
      }),
    ).toBe(false);
  });
});

describe('androidScanRequiresLocationServices', () => {
  it('flags Android 6 (API 23), the floor of the range', () => {
    expect(
      androidScanRequiresLocationServices({
        platformOs: 'android',
        androidApiLevel: 23,
        nativeBuildVersion: null,
      }),
    ).toBe(true);
  });

  it('flags Android 8 (API 26), mid-range', () => {
    expect(
      androidScanRequiresLocationServices({
        platformOs: 'android',
        androidApiLevel: 26,
        nativeBuildVersion: null,
      }),
    ).toBe(true);
  });

  it('flags Android 11 (API 30), the ceiling of the range', () => {
    expect(
      androidScanRequiresLocationServices({
        platformOs: 'android',
        androidApiLevel: 30,
        nativeBuildVersion: null,
      }),
    ).toBe(true);
  });

  it('stays off on Android 12 (API 31) — the permission-only gate takes over there', () => {
    expect(
      androidScanRequiresLocationServices({
        platformOs: 'android',
        androidApiLevel: 31,
        nativeBuildVersion: null,
      }),
    ).toBe(false);
  });

  it('stays off on a newer Android release', () => {
    expect(
      androidScanRequiresLocationServices({
        platformOs: 'android',
        androidApiLevel: 34,
        nativeBuildVersion: null,
      }),
    ).toBe(false);
  });

  it('stays off below Android 6', () => {
    expect(
      androidScanRequiresLocationServices({
        platformOs: 'android',
        androidApiLevel: 21,
        nativeBuildVersion: null,
      }),
    ).toBe(false);
  });

  it('stays off on iOS', () => {
    expect(
      androidScanRequiresLocationServices({
        platformOs: 'ios',
        androidApiLevel: 26,
        nativeBuildVersion: null,
      }),
    ).toBe(false);
  });

  it('is mutually exclusive with the permission gate at every API level, on old and new binaries', () => {
    for (const nativeBuildVersion of [LAST_BUILD_WITHOUT_FLAG, FIRST_BUILD_WITH_FLAG, null]) {
      for (let apiLevel = 21; apiLevel <= 36; apiLevel += 1) {
        const input: AndroidScanLocationGateInput = {
          platformOs: 'android',
          androidApiLevel: apiLevel,
          nativeBuildVersion,
        };
        const needsServices = androidScanRequiresLocationServices(input);
        const needsPermissionOnly = androidBuildHidesScanResultsWithoutLocation(input);
        expect(needsServices && needsPermissionOnly).toBe(false);
      }
    }
  });

  // Android 6-11 still needs Location services on to deliver scan results, flag
  // or no flag: `neverForLocation` only means something from Android 12.
  it('still asks for Location services on Android 11 with a flagged binary', () => {
    expect(
      androidScanRequiresLocationServices({
        platformOs: 'android',
        androidApiLevel: 30,
        nativeBuildVersion: FIRST_BUILD_WITH_FLAG,
      }),
    ).toBe(true);
  });
});
