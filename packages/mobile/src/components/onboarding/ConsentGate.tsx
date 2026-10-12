import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { useRouter, useSegments, type Href } from 'expo-router';
import { isConsentRecordOwnedBy, needsPrompt } from '@boardsesh/consent';
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
  // An answer this device gave signed out, or under another account, does not
  // answer for this account. Wait for the account read (capped below) to say
  // whether the account has its own answer or the climber is asked again.
  // While the profile id is still loading, an answer with no owner at all
  // waits too; one bound to some account settles, since it is almost always
  // this one. On the browser app the shared cookie never names an account, so
  // a signed-in page load always waits for this one read.
  const awaitingAccountAnswer =
    isAuthenticated &&
    !consent.accountResolved &&
    (authenticatedUserId === null
      ? !consent.record?.ownerAccountId
      : !isConsentRecordOwnedBy(consent.record, authenticatedUserId));

  const accountAnswerResolved = isAuthenticated && consent.accountResolved;

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
    if (settled || (!needsPrompt(consent.record) && !awaitingAccountAnswer)) {
      if (!settled) updateConsentState({ settled: true });
      if (!needsPrompt(consent.record) && routeRef.current[0] === 'privacy-consent') router.dismiss();
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = () => {
      if (cancelled) return;
      if (!needsPrompt(getConsentSnapshot().record)) {
        // The cap passed with a device answer still in place (offline): settle on
        // it. Tracking stays off until this account's answer resolves.
        updateConsentState({ settled: true });
        return;
      }
      if (routeRef.current[0] !== 'privacy-consent') router.push('/privacy-consent');
    };
    if (isAuthenticated) {
      serverWaitStartedAtRef.current ??= Date.now();
      // The sync effect above reads the account. When that read lands,
      // accountResolved runs this effect again; starting a read here would
      // toggle accountResolved and trigger another read while the prompt is open.
      // The profile id may still be loading; the 5-second cap covers that too.
      if (authenticatedUserId !== null && accountAnswerResolved) ask();
      else timer = setTimeout(ask, Math.max(0, CONSENT_SERVER_WAIT_MS - (Date.now() - serverWaitStartedAtRef.current)));
    } else ask();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    launchReady,
    consent.loaded,
    consent.record,
    accountAnswerResolved,
    awaitingAccountAnswer,
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
