import { useEffect } from 'react';
import { useSegments } from 'expo-router';
import { normalizeScreenPath } from '../../lib/analytics-screen-path';

/** Launch readiness is independent of analytics consent and content-render evidence. */
export function IntegrationNavigationObserver() {
  const segments = useSegments();
  const path = normalizeScreenPath(segments);
  useEffect(() => {
    if (path !== '/home') return;
    console.log('$screen /home');
    const readyUrl = process.env.EXPO_PUBLIC_SCREENSHOT_READY_URL;
    if (!readyUrl) return;
    let cancelled = false;
    void (async () => {
      for (let attempt = 0; attempt < 3 && !cancelled; attempt++) {
        try {
          if ((await fetch(readyUrl)).ok) return;
        } catch {
          /* A bounded retry handles a transient local connection failure. */
        }
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path]);
  return null;
}
