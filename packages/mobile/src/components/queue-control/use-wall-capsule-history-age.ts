import { useEffect, useReducer } from 'react';
import { AppState } from 'react-native';
import { useIsFocused } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { nowMs } from '../../lib/clock';
import { compactAgoParts } from '../../lib/format-relative-time';

/** History chrome updates at most once a minute, only while it can be seen. */
export function useWallCapsuleHistoryAge(sentAt: string | null, enabled: boolean): string | null {
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
  switch (unit) {
    case 'now':
      return t('mobile.boardPresence.litAgoNow');
    case 'minutes':
      return t('mobile.boardPresence.litAgoMinutes', { count });
    case 'hours':
      return t('mobile.boardPresence.litAgoHours', { count });
    case 'days':
      return t('mobile.boardPresence.litAgoDays', { count });
    case 'weeks':
      return t('mobile.boardPresence.litAgoWeeks', { count });
  }
}
