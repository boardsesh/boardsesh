'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  getPreference,
  removePreference,
  setPreference,
  subscribeToPreferenceChanges,
  type UserPreferenceKeyMap,
} from './user-preferences-db';

export type UseUserPreferenceResult<K extends keyof UserPreferenceKeyMap> = {
  value: UserPreferenceKeyMap[K] | null;
  isLoading: boolean;
  setValue: (next: UserPreferenceKeyMap[K]) => Promise<void>;
  clear: () => Promise<void>;
};

/**
 * Bind a single user preference to React state. On mount the hook reads
 * the value from IDB; thereafter it subscribes to the cross-tab
 * BroadcastChannel so any `setPreference`/`removePreference` call from
 * any tab — including another instance of this hook — updates local
 * state without re-hitting IDB.
 */
export function useUserPreference<K extends keyof UserPreferenceKeyMap>(key: K): UseUserPreferenceResult<K> {
  const [value, setLocalValue] = useState<UserPreferenceKeyMap[K] | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Track the live key so async reads that race a key change don't clobber
  // each other. Also used to filter broadcast messages.
  const keyRef = useRef<K>(key);
  keyRef.current = key;

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    void (async () => {
      const stored = await getPreference<UserPreferenceKeyMap[K], K>(key);
      if (cancelled || keyRef.current !== key) return;
      setLocalValue(stored);
      setIsLoading(false);
    })();

    const unsubscribe = subscribeToPreferenceChanges((message) => {
      if (message.key !== key) return;
      if (message.type === 'set') {
        setLocalValue(message.value as UserPreferenceKeyMap[K]);
      } else {
        setLocalValue(null);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [key]);

  const setValue = useCallback(
    async (next: UserPreferenceKeyMap[K]) => {
      // `setPreference` types via a conditional that TS can't narrow through
      // a generic — cast to the same shape via `unknown` to satisfy the
      // checker without weakening the public hook signature.
      await setPreference(
        key,
        next as unknown as K extends keyof UserPreferenceKeyMap ? UserPreferenceKeyMap[K] : unknown,
      );
    },
    [key],
  );

  const clear = useCallback(async () => {
    await removePreference(key);
  }, [key]);

  return { value, isLoading, setValue, clear };
}
