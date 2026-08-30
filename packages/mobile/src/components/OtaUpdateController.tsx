import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import * as Updates from 'expo-updates';
import { useAuth } from '../providers/auth-provider';
import { getNetworkPolicy, isNetworkAllowed, subscribeNetworkPolicy } from '../lib/network-policy';
import { reportHandledError } from '../lib/error-reporting';
import { checkForOtaUpdate, fetchOtaUpdate } from '../lib/ota-network';

const OTA_CHECK_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * Replaces expo-updates' pre-JS automatic check. Native config sets that check
 * to NEVER so a persisted local/hard-offline profile cannot make a request
 * before its policy is known; this controller checks only for an online account.
 */
export function OtaUpdateController(): null {
  const { accessCapabilities } = useAuth();
  const networkPolicy = useSyncExternalStore(subscribeNetworkPolicy, getNetworkPolicy, () => 'online');
  const inFlightRef = useRef<Promise<void> | null>(null);
  const lastCheckStartedAtRef = useRef(0);

  const checkForUpdate = useCallback((): void => {
    if (__DEV__ || !Updates.isEnabled || !accessCapabilities.useAccountFeatures || !isNetworkAllowed('ota')) return;
    if (inFlightRef.current) return;
    const now = Date.now();
    if (now - lastCheckStartedAtRef.current < OTA_CHECK_COOLDOWN_MS) return;
    lastCheckStartedAtRef.current = now;

    const updateCheck = (async () => {
      const result = await checkForOtaUpdate();
      if (!result.isAvailable || !isNetworkAllowed('ota')) return;
      await fetchOtaUpdate();
    })()
      .catch((error: unknown) => {
        reportHandledError(error, { tags: { source: 'ota', kind: 'policy-controlled-check' } });
      })
      .finally(() => {
        if (inFlightRef.current === updateCheck) inFlightRef.current = null;
      });
    inFlightRef.current = updateCheck;
  }, [accessCapabilities.useAccountFeatures]);

  useEffect(() => {
    if (networkPolicy !== 'online') return undefined;
    checkForUpdate();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') checkForUpdate();
    });
    return () => subscription.remove();
  }, [checkForUpdate, networkPolicy]);

  return null;
}
