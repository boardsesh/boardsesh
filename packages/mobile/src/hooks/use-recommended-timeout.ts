import { useEffect, useState } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

/**
 * `baseMs`, or longer when the climber set Android's "Time to take action"
 * (Settings › Accessibility, Android 10+) above it. Android answers with the
 * larger of the two, which is what its own Material Snackbar waits; iOS has no
 * such setting and keeps `baseMs`.
 *
 * `enabled` false skips the query and returns `baseMs`. Android sends no event
 * when the setting changes, so the query runs again each time `enabled` turns on.
 */
export function useRecommendedTimeout(baseMs: number, enabled: boolean): number {
  const [recommended, setRecommended] = useState<{ baseMs: number; timeoutMs: number } | null>(null);

  useEffect(() => {
    if (!enabled || Platform.OS !== 'android') return undefined;
    let mounted = true;
    AccessibilityInfo.getRecommendedTimeoutMillis(baseMs)
      .then((timeoutMs) => {
        if (mounted) setRecommended({ baseMs, timeoutMs });
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [baseMs, enabled]);

  if (!enabled || recommended == null || recommended.baseMs !== baseMs) return baseMs;
  return Math.max(baseMs, recommended.timeoutMs);
}
