import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';
import { useRouter, useSegments, type Href } from 'expo-router';
import { isConsentRecordOwnedBy, isRegionDefaultConsent, needsPrompt, type ConsentSource } from '@boardsesh/consent';
import { useAuth } from '../../providers/auth-provider';
import { usePartyProfile } from '../../providers/party-profile-provider';
import { useLaunchReady } from '../../providers/launch-ready-context';
import {
  applyRegionDefaultConsent,
  clearRegionDefaultConsent,
  getConsentCoordinator,
  useConsentSettled,
} from '../../providers/consent-provider';
import {
  expireConsentRegionLookup,
  isGlobalPrivacyControlEnabled,
  isConsentRegionLookupCurrent,
  lookUpConsentRegion,
} from '../../lib/consent-region';
import { getConsentSnapshot, subscribeConsent, updateConsentState } from '../../lib/consent-state';
import { readLocalConsent } from '../../lib/consent-storage';
import { consumeConsentDestination } from '../../lib/consent-navigation';
import { useFeatureFlag, useFeatureFlagsResolved } from '../../providers/feature-flags-provider';
import { setPosthogFlagIdentity, subscribePosthogInitialized } from '../../lib/posthog-client';

export { useConsentSettled } from '../../providers/consent-provider';
export const CONSENT_SERVER_WAIT_MS = 5000;

/**
 * The accounts (null for signed out) this process has applied the region
 * default for. Once per launch and account: if anything drops the default
 * again, the gate settles with no answer (nothing tracked, no prompt) instead
 * of applying it, reading the account and dropping it in a loop.
 */
const regionDefaultAppliedFor = new Set<string | null>();

/** Test seam: forget which accounts got the region default this launch. */
export function resetRegionDefaultGuard(): void {
  regionDefaultAppliedFor.clear();
}

function consentSource(): ConsentSource {
  return Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';
}

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

  // Region: the prompt is only shown in the prompt regions (and when the region
  // is unknown). Look it up as soon as the device turns out to have no answer,
  // so the answer is usually in by the time the prompt would open. A device that
  // holds a region default re-checks once per launch, and again on each foreground
  // resume: a prompt region drops the default and asks (a
  // climber who travelled into the EU). The default sends nothing until this
  // launch's answer says the region needs no prompt (`regionConfirmed`), so a
  // failed or slow lookup keeps it stored but switched off.
  const recordIsRegionDefault = isRegionDefaultConsent(consent.record);
  const recordNeedsPrompt = needsPrompt(consent.record);
  const [regionCheck, setRegionCheck] = useState(0);
  useEffect(() => {
    if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' || !consent.loaded || killed) return;
    if (!recordNeedsPrompt && !recordIsRegionDefault) return;
    let cancelled = false;
    const answer = lookUpConsentRegion();
    void answer.then((promptRequired) => {
      if (cancelled || !isConsentRegionLookupCurrent(answer)) return;
      // Global Privacy Control (browser app only) is a "no" outside the prompt regions.
      const regionDefaultAllowed = promptRequired === false && !isGlobalPrivacyControlEnabled();
      updateConsentState({ regionConfirmed: regionDefaultAllowed });
      // An unknown region (offline launch) keeps a stored default rather than
      // re-asking on every flaky start; it just sends nothing.
      if (promptRequired !== null && !regionDefaultAllowed && isRegionDefaultConsent(getConsentSnapshot().record))
        clearRegionDefaultConsent();
    });
    return () => {
      cancelled = true;
    };
  }, [consent.loaded, killed, recordNeedsPrompt, recordIsRegionDefault, regionCheck]);

  useEffect(() => {
    if (
      process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' ||
      !consent.loaded ||
      killed ||
      (!recordIsRegionDefault && !recordNeedsPrompt)
    )
      return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || !expireConsentRegionLookup()) return;
      // Hold capture until the fresh answer is in.
      updateConsentState({ regionConfirmed: false });
      setRegionCheck((count) => count + 1);
    });
    return () => subscription.remove();
  }, [consent.loaded, killed, recordIsRegionDefault, recordNeedsPrompt]);

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
    let asked = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = () => {
      if (cancelled || asked) return;
      if (!needsPrompt(getConsentSnapshot().record)) {
        // The cap passed with a device answer still in place (offline): settle on
        // it. Tracking stays off until this account's answer resolves.
        updateConsentState({ settled: true });
        return;
      }
      asked = true;
      // Capped at five seconds; an unknown region (null) asks.
      const answer = lookUpConsentRegion();
      void answer.then((promptRequired) => {
        if (cancelled || !isConsentRegionLookupCurrent(answer) || !needsPrompt(getConsentSnapshot().record)) return;
        if (promptRequired === false) {
          const accountKey = isAuthenticated ? authenticatedUserId : null;
          if (isGlobalPrivacyControlEnabled() || regionDefaultAppliedFor.has(accountKey)) {
            // No answer to store: Global Privacy Control said no, or this
            // launch already applied the default once for this account.
            updateConsentState({ settled: true });
            return;
          }
          regionDefaultAppliedFor.add(accountKey);
          applyRegionDefaultConsent(consentSource());
          return;
        }
        if (routeRef.current[0] !== 'privacy-consent') router.push('/privacy-consent');
      });
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
    regionCheck,
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
