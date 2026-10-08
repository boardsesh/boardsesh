import { useEffect, useRef } from 'react';
import { router, useSegments } from 'expo-router';
import { useLaunchReady } from '../../providers/launch-ready-context';
import { useConnectivity } from '../../lib/connectivity/use-connectivity';
import { useProfile } from '../../lib/graphql/hooks';
import { PRIVACY_ONBOARDING_VERSION, usePrivacySettings } from '../../lib/graphql/hooks/use-privacy';

/** Server completion follows the account across devices; dismissing never completes it. */
export function PrivacyOnboardingGate() {
  const ready = useLaunchReady();
  const segments = useSegments();
  const { effectiveOffline } = useConnectivity();
  const { data: profile } = useProfile();
  const { data: privacy } = usePrivacySettings();
  const presentedFor = useRef<string | null>(null);
  useEffect(() => {
    if (
      !ready ||
      effectiveOffline ||
      !profile?.id ||
      !privacy?.enabled ||
      privacy.privacyOnboardingVersion >= PRIVACY_ONBOARDING_VERSION
    )
      return;
    // Only a settled tab is eligible. An explicit join, climb share, auth flow,
    // first-board picker or existing modal keeps its navigation intact.
    if (segments[0] !== '(tabs)' || segments.length > 2 || presentedFor.current === profile.id) return;
    const timer = setTimeout(() => {
      presentedFor.current = profile.id;
      router.push('/settings/privacy-onboarding');
    }, 1500);
    return () => clearTimeout(timer);
  }, [ready, effectiveOffline, profile?.id, privacy, segments]);
  return null;
}
