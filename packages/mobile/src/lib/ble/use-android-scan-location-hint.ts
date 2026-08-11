// Drives the "Android is hiding the scan results until Location is allowed"
// empty-state hint. See android-scan-location-gate.ts for why the hint exists
// and why it stays until the manifest changes.

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import {
  androidApiLevel,
  getAndroidLocationPermissionState,
  requestAndroidScanLocationPermission,
} from './android-location-permission';
import { getAndroidLocationServicesState, promptEnableAndroidLocationServices } from './android-location-services';
import {
  androidBuildHidesScanResultsWithoutLocation,
  androidScanRequiresLocationServices,
} from './android-scan-location-gate';

export type AndroidScanLocationHint = {
  /**
   * True when an empty scan on this binary is plausibly Android suppressing
   * results, and granting location is a real remedy. Consumers should swap their
   * generic hardware troubleshooting copy for the location copy + grant button.
   */
  shouldOfferLocationGrant: boolean;
  /** True once the user granted location from the hint — prompt them to rescan. */
  wasGranted: boolean;
  /** True while the system dialog is up. */
  isRequesting: boolean;
  /** Fires the system prompt; resolves to whether it was granted. */
  requestLocationPermission: () => Promise<boolean>;
  /**
   * True on Android 6-11 (API 23-30) when an empty scan is plausibly the
   * system Location toggle being off — the permission is irrelevant on this
   * range, it's the services switch AOSP gates scan delivery on. `false` when
   * the state is unknown (`null`), so an indeterminate read falls back to the
   * generic troubleshooting copy rather than guessing.
   */
  shouldOfferLocationServicesEnable: boolean;
  /** True once the services toggle was observed on after being off — prompt a rescan. */
  servicesWereEnabled: boolean;
  /** True while the enable-services flow (dialog or settings handoff) is in progress. */
  isPromptingServices: boolean;
  /** Fires the enable-services flow; resolves to whether it was confirmed enabled in-app. */
  promptEnableLocationServices: () => Promise<boolean>;
};

/**
 * @param active Whether a zero-result state is currently on screen. The
 *   permission read is deferred until then so nothing runs on every scan tick.
 */
export function useAndroidScanLocationHint(active: boolean): AndroidScanLocationHint {
  const [locationGranted, setLocationGranted] = useState<boolean | null>(null);
  const [isRequesting, setIsRequesting] = useState(false);
  const [wasGranted, setWasGranted] = useState(false);
  // A late `check` resolution must not overwrite state after the sheet closed
  // (or after the user granted from the button).
  const activeReadRef = useRef(0);

  const [servicesEnabled, setServicesEnabled] = useState<boolean | null>(null);
  const [isPromptingServices, setIsPromptingServices] = useState(false);
  const [servicesWereEnabled, setServicesWereEnabled] = useState(false);
  // Same stale-read guard as activeReadRef above, kept separate because the
  // permission and services reads are independent flows (mutually exclusive by
  // API level, but no reason to couple their lifecycles).
  const servicesReadRef = useRef(0);

  const buildHidesResults = androidBuildHidesScanResultsWithoutLocation({
    platformOs: Platform.OS,
    androidApiLevel: androidApiLevel(),
  });
  const requiresServices = androidScanRequiresLocationServices({
    platformOs: Platform.OS,
    androidApiLevel: androidApiLevel(),
  });

  useEffect(() => {
    if (!active || !buildHidesResults) {
      setLocationGranted(null);
      setWasGranted(false);
      activeReadRef.current += 1;
      return;
    }

    const readId = activeReadRef.current + 1;
    activeReadRef.current = readId;
    void getAndroidLocationPermissionState().then((granted) => {
      if (activeReadRef.current !== readId) return;
      setLocationGranted(granted);
    });
  }, [active, buildHidesResults]);

  const readServicesState = useCallback(() => {
    const readId = servicesReadRef.current + 1;
    servicesReadRef.current = readId;
    void getAndroidLocationServicesState().then((enabled) => {
      if (servicesReadRef.current !== readId) return;
      setServicesEnabled(enabled);
      if (enabled) setServicesWereEnabled(true);
    });
  }, []);

  useEffect(() => {
    if (!active || !requiresServices) {
      setServicesEnabled(null);
      setServicesWereEnabled(false);
      servicesReadRef.current += 1;
      return;
    }

    readServicesState();
  }, [active, requiresServices, readServicesState]);

  // The only way the services toggle changes while our hint is on screen is
  // the user leaving to the system Location settings (the sendIntent fallback
  // in promptEnableAndroidLocationServices) and coming back — re-check on
  // foreground so the hint clears itself without another tap.
  useEffect(() => {
    if (!active || !requiresServices) return;

    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') readServicesState();
    });
    return () => subscription.remove();
  }, [active, requiresServices, readServicesState]);

  const requestLocationPermission = useCallback(async () => {
    // Retire any read that is still in flight before the dialog goes up. The
    // system prompt is the newer, more authoritative answer; a `check` that
    // started earlier and resolves `false` afterwards would otherwise sail past
    // the readId guard (the counter having never moved) and put the grant button
    // straight back in front of a user who just accepted.
    activeReadRef.current += 1;
    setIsRequesting(true);
    try {
      const granted = await requestAndroidScanLocationPermission();
      setLocationGranted(granted);
      setWasGranted(granted);
      return granted;
    } finally {
      setIsRequesting(false);
    }
  }, []);

  const promptEnableLocationServices = useCallback(async () => {
    servicesReadRef.current += 1;
    setIsPromptingServices(true);
    try {
      const enabled = await promptEnableAndroidLocationServices();
      setServicesEnabled(enabled);
      if (enabled) setServicesWereEnabled(true);
      return enabled;
    } finally {
      setIsPromptingServices(false);
    }
  }, []);

  return {
    shouldOfferLocationGrant: buildHidesResults && active && locationGranted === false,
    wasGranted,
    isRequesting,
    requestLocationPermission,
    shouldOfferLocationServicesEnable: requiresServices && active && servicesEnabled === false,
    servicesWereEnabled,
    isPromptingServices,
    promptEnableLocationServices,
  };
}
