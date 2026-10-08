import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { useRouter, useSegments, type Href } from 'expo-router';
import { needsPrompt } from '@boardsesh/consent';
import { useAuth } from '../../providers/auth-provider';
import { usePartyProfile } from '../../providers/party-profile-provider';
import { useLaunchReady } from '../../providers/launch-ready-context';
import { getConsentCoordinator, useConsentSettled } from '../../providers/consent-provider';
import { getConsentSnapshot, subscribeConsent, updateConsentState } from '../../lib/consent-state';
import { readLocalConsent } from '../../lib/consent-storage';
import { consumeConsentDestination } from '../../lib/consent-navigation';
import { useFeatureFlag, useFeatureFlagsResolved } from '../../providers/feature-flags-provider';
import { setPosthogFlagIdentity, subscribePosthogInitialized } from '../../lib/posthog-client';

export { useConsentSettled } from '../../providers/consent-provider';
export const CONSENT_SERVER_WAIT_MS = 5000;

export function ConsentGate(): null {
  const consent = useSyncExternalStore(subscribeConsent, getConsentSnapshot, getConsentSnapshot);
  const settled = useConsentSettled();
  const launchReady = useLaunchReady();
  const { isAuthenticated, isLoading } = useAuth();
  const { authenticatedUserId } = usePartyProfile();
  const killed = useFeatureFlag('privacy-consent-step-kill') === true;
  const flagsResolved = useFeatureFlagsResolved();
  const router = useRouter();
  const segments = useSegments();
  const routeRef = useRef<readonly string[]>(segments);
  const serverWaitStartedAtRef = useRef<number | null>(null);
  routeRef.current = segments;

  useLayoutEffect(() => {
    updateConsentState({ killed, flagsResolved });
  }, [killed, flagsResolved]);

  useEffect(() => {
    const updateFlags = () => setPosthogFlagIdentity(isAuthenticated ? authenticatedUserId : null);
    updateFlags();
    return subscribePosthogInitialized(updateFlags);
  }, [isAuthenticated, authenticatedUserId, consent.authSettled, consent.accountId, consent.record?.analytics, killed]);

  useEffect(() => {
    if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') return;
    if (!consent.loaded) return;
    const controller = getConsentCoordinator();
    if (!controller) return;
    const authSettled = !isLoading && (!isAuthenticated || authenticatedUserId !== null);
    updateConsentState({
      authSettled,
      accountId: isAuthenticated ? authenticatedUserId : null,
      accountResolved: authSettled && !isAuthenticated,
    });
    if (!authSettled) return;
    controller.setAccount(isAuthenticated ? authenticatedUserId : null);
    updateConsentState({
      accountId: isAuthenticated ? authenticatedUserId : null,
      accountResolved: controller.getSnapshot().accountResolved && !controller.getSnapshot().syncing,
    });
    let cancelled = false;
    const synchronize = async () => {
      const local = await readLocalConsent().catch(() => consent.record);
      if (cancelled) return;
      controller.replaceLocalRecord(local);
      await controller.sync();
    };
    void synchronize();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void synchronize();
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [consent.loaded, isAuthenticated, isLoading, authenticatedUserId, consent.authEpoch]);

  useEffect(() => {
    if (!launchReady || !consent.loaded) return;
    if (isAuthenticated) serverWaitStartedAtRef.current ??= Date.now();
    if (!flagsResolved) return;
    if (killed || process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') {
      updateConsentState({ settled: true });
      if (routeRef.current[0] === 'privacy-consent') router.dismiss();
      return;
    }
    if (settled || !needsPrompt(consent.record)) {
      if (!settled) updateConsentState({ settled: true });
      if (!needsPrompt(consent.record) && routeRef.current[0] === 'privacy-consent') router.dismiss();
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = () => {
      if (cancelled || !needsPrompt(getConsentSnapshot().record)) return;
      if (routeRef.current[0] !== 'privacy-consent') router.push('/privacy-consent');
    };
    if (isAuthenticated) {
      serverWaitStartedAtRef.current ??= Date.now();
      timer = setTimeout(ask, Math.max(0, CONSENT_SERVER_WAIT_MS - (Date.now() - serverWaitStartedAtRef.current)));
      // The profile id may still be loading; the 5-second cap covers that too.
      if (authenticatedUserId) void getConsentCoordinator()?.sync().then(ask);
    } else ask();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    launchReady,
    consent.loaded,
    consent.record,
    settled,
    killed,
    flagsResolved,
    isAuthenticated,
    authenticatedUserId,
    router,
  ]);

  useEffect(() => {
    if (!settled || segments[0] === 'privacy-consent') return;
    const destination = consumeConsentDestination();
    if (destination) router.navigate(destination as Href);
  }, [settled, segments, router]);
  return null;
}
