import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Platform } from 'react-native';
import { useIsFocused } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import {
  MOBILE_STORE_RELEASE,
  type MobileStoreReleaseQueryResponse,
  type MobileStoreReleaseQueryVariables,
} from '@boardsesh/graphql';
import { parseNumericVersion, type MobileStoreRelease } from '@boardsesh/shared-schema/mobile-store-release';
import { getHttpClient } from '../graphql/client';
import { getPreference, setPreference } from '../preference-store';
import { useIsAppActive, useIsAppBackgrounded } from '../app-visibility';
import { readConnectStepBuild } from '../onboarding/connect-step-build';
import { useLaunchReady } from '../../providers/launch-ready-context';
import { useQueueSessionId } from '../../providers/queue-provider';
import {
  getStoreUpdateStage,
  makeStoreUpdateQaRelease,
  parseStoreUpdateAcknowledgment,
  readStoreUpdateQaStage,
  type StoreUpdateAcknowledgment,
} from './nudge-policy';

const ACKNOWLEDGMENT_KEY = 'storeUpdateAcknowledgmentV1';
/** Survives native updates: a climber who opts out is never reminded again on this install. */
const REMINDERS_OFF_KEY = 'storeUpdateRemindersOffV1';

export function useStoreUpdateNudge(enabled: boolean) {
  const focused = useIsFocused();
  const active = useIsAppActive();
  const backgrounded = useIsAppBackgrounded();
  const launchReady = useLaunchReady();
  const { sessionId } = useQueueSessionId();
  const build = readConnectStepBuild();
  const qaStage = readStoreUpdateQaStage();
  const nativeVersion = qaStage ? '2.6.0' : build.nativeVersion;
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  const allowedBuild =
    Platform.OS !== 'web' &&
    (qaStage !== null || (build.productionBuild && process.env.EXPO_PUBLIC_SCREENSHOT_MODE !== '1'));
  // Strict `active` gates the first appearance only. Once shown, the card rides
  // out iOS `inactive` (Control Center, Face ID, a call) and leaves on background.
  const [shown, setShown] = useState(false);
  const foreground = active || (shown && !backgrounded);
  const eligible = enabled && focused && foreground && launchReady && sessionId === null && allowedBuild;
  const preferenceKey = qaStage ? `${ACKNOWLEDGMENT_KEY}:qa:${qaStage}` : ACKNOWLEDGMENT_KEY;
  const remindersOffKey = qaStage ? `${REMINDERS_OFF_KEY}:qa:${qaStage}` : REMINDERS_OFF_KEY;
  const [acknowledgment, setAcknowledgment] = useState<StoreUpdateAcknowledgment | null>();
  const [remindersOff, setRemindersOff] = useState<boolean>();
  const [storageFailed, setStorageFailed] = useState(false);
  const [openingStore, setOpeningStore] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const [currentTimeMs, setCurrentTimeMs] = useState(Date.now);
  // This hook is the only writer of both keys, so one successful read per key
  // pair stays true until a write fails. Refocus must not re-read and blink.
  const storedStateLoaded = useRef(false);

  useEffect(() => {
    storedStateLoaded.current = false;
    setAcknowledgment(undefined);
    setRemindersOff(undefined);
  }, [preferenceKey, remindersOffKey]);

  useEffect(() => {
    if (!eligible || storedStateLoaded.current) return;
    let cancelled = false;
    setStorageFailed(false);
    void Promise.all([getPreference<unknown>(preferenceKey), getPreference<unknown>(remindersOffKey)])
      .then(([storedAcknowledgment, storedRemindersOff]) => {
        if (cancelled) return;
        storedStateLoaded.current = true;
        setAcknowledgment(parseStoreUpdateAcknowledgment(storedAcknowledgment));
        setRemindersOff(storedRemindersOff === true);
      })
      .catch(() => {
        if (!cancelled) setStorageFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [eligible, preferenceKey, remindersOffKey]);

  useEffect(() => {
    if (!eligible) return;
    // Re-evaluate age, freshness and cooldown without requiring a remount.
    setCurrentTimeMs(Date.now());
    const timer = setInterval(() => setCurrentTimeMs(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [eligible]);

  const queryEnabled =
    eligible && remindersOff === false && qaStage === null && parseNumericVersion(nativeVersion) !== null;
  const query = useQuery({
    queryKey: ['mobileStoreRelease', platform, nativeVersion],
    queryFn: async (): Promise<MobileStoreRelease | null> => {
      try {
        const variables: MobileStoreReleaseQueryVariables = { platform, nativeVersion: nativeVersion ?? '' };
        const response = await getHttpClient().request<MobileStoreReleaseQueryResponse>(
          MOBILE_STORE_RELEASE,
          variables,
        );
        return response.mobileStoreRelease;
      } catch {
        // Optional advice must not make an older backend or failed connection noisy.
        return null;
      }
    },
    enabled: queryEnabled,
    staleTime: 60 * 60 * 1000,
    refetchInterval: queryEnabled ? 60 * 60 * 1000 : false,
    retry: false,
  });
  const release = qaStage ? makeStoreUpdateQaRelease(qaStage, currentTimeMs) : (query.data ?? null);
  const stage =
    eligible && !storageFailed && acknowledgment !== undefined && remindersOff === false
      ? getStoreUpdateStage({ release, nativeVersion, acknowledgment, nowMs: currentTimeMs })
      : null;
  useEffect(() => {
    setShown(stage !== null);
  }, [stage]);

  const acknowledge = useCallback(() => {
    const installed = parseNumericVersion(nativeVersion);
    if (!installed) return;
    const next = { nativeVersion: installed.join('.'), lastAcknowledgedAtMs: Date.now() };
    setAcknowledgment(next);
    setOpenFailed(false);
    void setPreference(preferenceKey, next).catch(() => {
      storedStateLoaded.current = false;
      setStorageFailed(true);
    });
  }, [nativeVersion, preferenceKey]);

  const turnOffReminders = useCallback(() => {
    setRemindersOff(true);
    setOpenFailed(false);
    void setPreference(remindersOffKey, true).catch(() => {
      storedStateLoaded.current = false;
      setStorageFailed(true);
    });
  }, [remindersOffKey]);

  const openStore = useCallback(async () => {
    if (!release || openingStore) return;
    setOpeningStore(true);
    setOpenFailed(false);
    try {
      const storeUrl =
        qaStage && platform === 'android'
          ? 'https://play.google.com/store/apps/details?id=com.boardsesh.app'
          : release.storeUrl;
      await Linking.openURL(storeUrl);
      acknowledge();
    } catch {
      setOpenFailed(true);
    } finally {
      setOpeningStore(false);
    }
  }, [release, openingStore, qaStage, platform, acknowledge]);

  return { stage, release, platform, openingStore, openFailed, acknowledge, turnOffReminders, openStore };
}
