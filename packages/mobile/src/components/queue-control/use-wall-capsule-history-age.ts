import { useEffect, useReducer } from 'react';
import { AppState } from 'react-native';
import { useIsFocused } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { nowMs } from '../../lib/clock';
import { compactAgoParts } from '../../lib/format-relative-time';

/**
 * How long ago the wall's climb was lit: `label` ("20m") for spoken labels and
 * the Material overline, `byline` ("20m ago", "Just now") under the name in the
 * iOS capsule.
 */
export type WallCapsuleHistoryAge = { label: string; byline: string };

/** History chrome updates at most once a minute, only while it can be seen. */
export function useWallCapsuleHistoryAge(sentAt: string | null, enabled: boolean): WallCapsuleHistoryAge | null {
  const { t } = useTranslation('session');
  const focused = useIsFocused();
  const [, refresh] = useReducer((revision: number) => revision + 1, 0);
  const litAt = sentAt === null ? Number.NaN : Date.parse(sentAt);

  useEffect(() => {
    if (!enabled || !focused || !Number.isFinite(litAt)) return undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const start = () => {
      stop();
      timer = setInterval(refresh, 60_000);
    };
    if (AppState.currentState !== 'background' && AppState.currentState !== 'inactive') start();
    const subscription = AppState.addEventListener('change', (state) => {
      stop();
      if (state === 'active') {
        refresh();
        start();
      }
    });
    return () => {
      stop();
      subscription.remove();
    };
  }, [enabled, focused, litAt]);

  if (!enabled || !Number.isFinite(litAt)) return null;
  const { unit, count } = compactAgoParts(litAt, nowMs());
  if (unit === 'now') {
    return { label: t('mobile.boardPresence.litAgoNow'), byline: t('mobile.boardPresence.litAgoBylineNow') };
  }
  const label =
    unit === 'minutes'
      ? t('mobile.boardPresence.litAgoMinutes', { count })
      : unit === 'hours'
        ? t('mobile.boardPresence.litAgoHours', { count })
        : unit === 'days'
          ? t('mobile.boardPresence.litAgoDays', { count })
          : t('mobile.boardPresence.litAgoWeeks', { count });
  return { label, byline: t('mobile.boardPresence.litAgoByline', { age: label }) };
}
