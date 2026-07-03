import { useEffect } from 'react';
import { Platform } from 'react-native';
import { maybeFetchAndAttachInstallReferrer } from '../../lib/install-referrer';

// Android-only: Play Install Referrer is a Play Store mechanism with no iOS
// equivalent in this PR (see install-referrer.ts). Fire-and-forget after
// mount so this never blocks the splash/auth gate — matches OtaUpdateTracker's
// shape. Renders nothing; mounted once near the app root beside it.
export function InstallReferrerTracker(): null {
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    void maybeFetchAndAttachInstallReferrer();
  }, []);

  return null;
}
