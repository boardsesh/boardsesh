// The In range slot's answer to "No boards in range" when Android is plausibly
// withholding what the scan heard (lib/ble/android-scan-location-gate.ts): on
// a binary built before the manifest change, the location grant; on Android 6
// to 11 with Location switched off, the switch. The Bluetooth quickstart sheet
// offered both until the slot replaced it; the device picker still does.

import { useCallback, useMemo } from 'react';
import { useAndroidScanLocationHint } from '../../lib/ble/use-android-scan-location-hint';
import type { InRangeLocationHint } from './InRangeSection';

/** Which fix to offer, if any. The grant wins: on those binaries the switch is not the gate. */
export function inRangeLocationHintKind({
  shouldOfferLocationGrant,
  shouldOfferLocationServicesEnable,
}: {
  shouldOfferLocationGrant: boolean;
  shouldOfferLocationServicesEnable: boolean;
}): InRangeLocationHint['kind'] | null {
  if (shouldOfferLocationGrant) return 'grant_location';
  if (shouldOfferLocationServicesEnable) return 'enable_location_services';
  return null;
}

/**
 * @param active The slot shows its nothing-heard state; nothing is read otherwise.
 * @param rescan Starts a fresh scan once the fix has worked.
 */
export function useInRangeLocationHint(active: boolean, rescan: () => void): InRangeLocationHint | null {
  const hint = useAndroidScanLocationHint(active);
  const {
    shouldOfferLocationGrant,
    shouldOfferLocationServicesEnable,
    isRequesting,
    isPromptingServices,
    requestLocationPermission,
    promptEnableLocationServices,
  } = hint;
  const grantLocation = useCallback(() => {
    void requestLocationPermission().then((granted) => {
      if (granted) rescan();
    });
  }, [requestLocationPermission, rescan]);
  const enableLocationServices = useCallback(() => {
    void promptEnableLocationServices().then((enabled) => {
      if (enabled) rescan();
    });
  }, [promptEnableLocationServices, rescan]);
  const kind = inRangeLocationHintKind({ shouldOfferLocationGrant, shouldOfferLocationServicesEnable });
  return useMemo(() => {
    switch (kind) {
      case 'grant_location':
        return { kind, busy: isRequesting, onPress: grantLocation };
      case 'enable_location_services':
        return { kind, busy: isPromptingServices, onPress: enableLocationServices };
      case null:
        return null;
    }
  }, [kind, isRequesting, isPromptingServices, grantLocation, enableLocationServices]);
}
