import { useEffect, useRef } from 'react';
import { useSegments } from 'expo-router';
import { scopedRouter as router } from '../../lib/routing/scoped-navigation';
import { useLaunchReady } from '../../providers/launch-ready-context';
import { useConsentSettled } from '../../lib/consent-hooks';
import { getConsentSnapshot } from '../../lib/consent-state';
import { useConnectivity } from '../../lib/connectivity/use-connectivity';
import { useProfile } from '../../lib/graphql/hooks';
import { PRIVACY_ONBOARDING_VERSION, usePrivacySettings } from '../../lib/graphql/hooks/use-privacy';

/** Server completion follows the account across devices; dismissing never completes it. */
export function PrivacyOnboardingGate() {
  const launchReady = useLaunchReady();
  const consentSettled = useConsentSettled();
  const ready = launchReady && consentSettled;
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
      if (!getConsentSnapshot().settled) return;
      presentedFor.current = profile.id;
      router.push('/settings/privacy-onboarding');
    }, 1500);
    return () => clearTimeout(timer);
  }, [ready, effectiveOffline, profile?.id, privacy, segments]);
  return null;
}
