'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isNativeApp } from '@/app/lib/ble/capacitor-utils';

/**
 * Custom hook to manage screen wake lock.
 * On web, uses the Screen Wake Lock API.
 * On native apps, uses Capacitor's KeepAwake plugin.
 *
 * The wake lock is automatically re-acquired when the page becomes visible
 * after being hidden, as wake locks are released when the page is hidden.
 *
 * @param enabled - Whether the wake lock should be active
 * @returns Object containing the current state and manual control functions
 */
export function useWakeLock(enabled: boolean) {
  const [isSupported, setIsSupported] = useState(false);
  const [isActive, setIsActive] = useState(false);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  // Check if wake lock is supported (web or native)
  useEffect(() => {
    if (isNativeApp()) {
      const plugin = window.Capacitor?.Plugins?.KeepAwake;
      if (plugin) {
        plugin
          .isSupported()
          .then(({ isSupported: supported }) => {
            setIsSupported(supported);
          })
          .catch(() => setIsSupported(false));
        return;
      }
    }
    setIsSupported('wakeLock' in navigator);
  }, []);

  // Request wake lock (native or web)
  const requestWakeLock = useCallback(async () => {
    if (isNativeApp()) {
      try {
        const plugin = window.Capacitor?.Plugins?.KeepAwake;
        if (plugin) {
          await plugin.keepAwake();
          setIsActive(true);
        }
      } catch (err) {
        console.warn('KeepAwake request failed:', err);
        setIsActive(false);
      }
      return;
    }

    if (!('wakeLock' in navigator)) {
      return;
    }

    try {
      wakeLockRef.current = await navigator.wakeLock.request('screen');
      setIsActive(true);

      // Listen for release event (e.g., when page becomes hidden)
      wakeLockRef.current.addEventListener('release', () => {
        setIsActive(false);
      });
    } catch (err) {
      // Wake lock request can fail if:
      // - The document is not visible
      // - The device is low on battery
      // - The user has disabled wake locks
      console.warn('Wake Lock request failed:', err);
      setIsActive(false);
    }
  }, []);

  // Release wake lock (native or web)
  const releaseWakeLock = useCallback(async () => {
    if (isNativeApp()) {
      try {
        const plugin = window.Capacitor?.Plugins?.KeepAwake;
        if (plugin) {
          await plugin.allowSleep();
          setIsActive(false);
        }
      } catch (err) {
        console.warn('KeepAwake release failed:', err);
      }
      return;
    }

    if (wakeLockRef.current) {
      try {
        await wakeLockRef.current.release();
        wakeLockRef.current = null;
        setIsActive(false);
      } catch (err) {
        console.warn('Wake Lock release failed:', err);
      }
    }
  }, []);

  // Manage wake lock based on enabled state
  useEffect(() => {
    if (enabled && isSupported) {
      void requestWakeLock();
    } else {
      void releaseWakeLock();
    }

    return () => {
      void releaseWakeLock();
    };
  }, [enabled, isSupported, requestWakeLock, releaseWakeLock]);

  // Re-acquire wake lock when page becomes visible again
  // Wake locks are automatically released when the page is hidden
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && enabled && isSupported) {
        void requestWakeLock();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [enabled, isSupported, requestWakeLock]);

  return {
    isSupported,
    isActive,
    requestWakeLock,
    releaseWakeLock,
  };
}
