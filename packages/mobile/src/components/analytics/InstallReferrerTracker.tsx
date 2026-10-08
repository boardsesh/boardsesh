import { useEffect } from 'react';
import { Platform } from 'react-native';
import { maybeFetchAndAttachInstallReferrer } from '../../lib/install-referrer';
import { useAnalyticsConsent } from '../../lib/consent-hooks';

// Android-only: Play Install Referrer is a Play Store mechanism with no iOS
// equivalent in this PR (see install-referrer.ts). Fire-and-forget after
// mount so this never blocks the splash/auth gate — matches OtaUpdateTracker's
// shape. Renders nothing; mounted once near the app root beside it.
export function InstallReferrerTracker(): null {
  const granted = useAnalyticsConsent();
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    void maybeFetchAndAttachInstallReferrer();
  }, [granted]);

  return null;
}
