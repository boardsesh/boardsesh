import { useEffect } from 'react';
import { Platform } from 'react-native';
import { maybeFetchAndAttachInstallReferrer } from '../../lib/install-referrer';
import { useAnalyticsConsent, useAnalyticsRegionDefault } from '../../lib/consent-hooks';

// Android-only: Play Install Referrer is a Play Store mechanism with no iOS
// equivalent in this PR (see install-referrer.ts). Fire-and-forget after
// mount so this never blocks the splash/auth gate — matches OtaUpdateTracker's
// shape. Renders nothing; mounted once near the app root beside it.
// Re-runs when the consent answer changes: nothing is read from Play before
// the climber's own Allow, so the first effective Allow is what triggers the
// read. Outside the prompt regions analytics is already on by the region
// default, so an explicit Allow there changes only `regionDefault`.
export function InstallReferrerTracker(): null {
  const granted = useAnalyticsConsent();
  const regionDefault = useAnalyticsRegionDefault();
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    void maybeFetchAndAttachInstallReferrer();
  }, [granted, regionDefault]);

  return null;
}
