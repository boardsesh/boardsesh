import { useEffect } from 'react';
import { Platform } from 'react-native';
import { maybeFetchAndAttachInstallReferrer } from '../../lib/install-referrer';
import { useAnalyticsConsent } from '../../lib/consent-hooks';

export function InstallReferrerTracker(): null {
  const granted = useAnalyticsConsent();
  useEffect(() => {
    if (Platform.OS !== 'android' || !granted) return;
    void maybeFetchAndAttachInstallReferrer();
  }, [granted]);

  return null;
}
